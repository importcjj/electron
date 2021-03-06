'user strict';

var WebViewImpl, deprecate, getNextId, guestViewInternal, ipcRenderer, listener, nextId, ref, registerBrowserPluginElement, registerWebViewElement, remote, useCapture, v8Util, webFrame, webViewConstants,
  hasProp = {}.hasOwnProperty,
  slice = [].slice;

ref = require('electron'), deprecate = ref.deprecate, webFrame = ref.webFrame, remote = ref.remote, ipcRenderer = ref.ipcRenderer;

v8Util = process.atomBinding('v8_util');

guestViewInternal = require('./guest-view-internal');

webViewConstants = require('./web-view-constants');

// ID generator.
nextId = 0;

getNextId = function() {
  return ++nextId;
};

// Represents the internal state of the WebView node.
WebViewImpl = (function() {
  function WebViewImpl(webviewNode) {
    var shadowRoot;
    this.webviewNode = webviewNode;
    v8Util.setHiddenValue(this.webviewNode, 'internal', this);
    this.attached = false;
    this.elementAttached = false;
    this.beforeFirstNavigation = true;

    // on* Event handlers.
    this.on = {};
    this.browserPluginNode = this.createBrowserPluginNode();
    shadowRoot = this.webviewNode.createShadowRoot();
    this.setupWebViewAttributes();
    this.setupFocusPropagation();
    this.viewInstanceId = getNextId();
    shadowRoot.appendChild(this.browserPluginNode);

    // Subscribe to host's zoom level changes.
    this.onZoomLevelChanged = (zoomLevel) => {
      this.webviewNode.setZoomLevel(zoomLevel);
    }
    webFrame.on('zoom-level-changed', this.onZoomLevelChanged);
  }

  WebViewImpl.prototype.createBrowserPluginNode = function() {
    // We create BrowserPlugin as a custom element in order to observe changes
    // to attributes synchronously.
    var browserPluginNode;
    browserPluginNode = new WebViewImpl.BrowserPlugin();
    v8Util.setHiddenValue(browserPluginNode, 'internal', this);
    return browserPluginNode;
  };

  // Resets some state upon reattaching <webview> element to the DOM.
  WebViewImpl.prototype.reset = function() {
    // Unlisten the zoom-level-changed event.
    webFrame.removeListener('zoom-level-changed', this.onZoomLevelChanged);

    // If guestInstanceId is defined then the <webview> has navigated and has
    // already picked up a partition ID. Thus, we need to reset the initialization
    // state. However, it may be the case that beforeFirstNavigation is false BUT
    // guestInstanceId has yet to be initialized. This means that we have not
    // heard back from createGuest yet. We will not reset the flag in this case so
    // that we don't end up allocating a second guest.
    if (this.guestInstanceId) {
      guestViewInternal.destroyGuest(this.guestInstanceId);
      this.webContents = null;
      this.guestInstanceId = void 0;
      this.beforeFirstNavigation = true;
      this.attributes[webViewConstants.ATTRIBUTE_PARTITION].validPartitionId = true;
    }
    return this.internalInstanceId = 0;
  };

  // Sets the <webview>.request property.
  WebViewImpl.prototype.setRequestPropertyOnWebViewNode = function(request) {
    return Object.defineProperty(this.webviewNode, 'request', {
      value: request,
      enumerable: true
    });
  };

  WebViewImpl.prototype.setupFocusPropagation = function() {
    if (!this.webviewNode.hasAttribute('tabIndex')) {

      // <webview> needs a tabIndex in order to be focusable.
      // TODO(fsamuel): It would be nice to avoid exposing a tabIndex attribute
      // to allow <webview> to be focusable.
      // See http://crbug.com/231664.
      this.webviewNode.setAttribute('tabIndex', -1);
    }
    this.webviewNode.addEventListener('focus', (function(_this) {
      return function(e) {

        // Focus the BrowserPlugin when the <webview> takes focus.
        return _this.browserPluginNode.focus();
      };
    })(this));
    return this.webviewNode.addEventListener('blur', (function(_this) {
      return function(e) {

        // Blur the BrowserPlugin when the <webview> loses focus.
        return _this.browserPluginNode.blur();
      };
    })(this));
  };


  // This observer monitors mutations to attributes of the <webview> and
  // updates the BrowserPlugin properties accordingly. In turn, updating
  // a BrowserPlugin property will update the corresponding BrowserPlugin
  // attribute, if necessary. See BrowserPlugin::UpdateDOMAttribute for more
  // details.
  WebViewImpl.prototype.handleWebviewAttributeMutation = function(attributeName, oldValue, newValue) {
    if (!this.attributes[attributeName] || this.attributes[attributeName].ignoreMutation) {
      return;
    }

    // Let the changed attribute handle its own mutation;
    return this.attributes[attributeName].handleMutation(oldValue, newValue);
  };

  WebViewImpl.prototype.handleBrowserPluginAttributeMutation = function(attributeName, oldValue, newValue) {
    if (attributeName === webViewConstants.ATTRIBUTE_INTERNALINSTANCEID && !oldValue && !!newValue) {
      this.browserPluginNode.removeAttribute(webViewConstants.ATTRIBUTE_INTERNALINSTANCEID);
      this.internalInstanceId = parseInt(newValue);

      // Track when the element resizes using the element resize callback.
      webFrame.registerElementResizeCallback(this.internalInstanceId, this.onElementResize.bind(this));
      if (!this.guestInstanceId) {
        return;
      }
      return guestViewInternal.attachGuest(this.internalInstanceId, this.guestInstanceId, this.buildParams());
    }
  };

  WebViewImpl.prototype.onSizeChanged = function(webViewEvent) {
    var height, maxHeight, maxWidth, minHeight, minWidth, newHeight, newWidth, node, width;
    newWidth = webViewEvent.newWidth;
    newHeight = webViewEvent.newHeight;
    node = this.webviewNode;
    width = node.offsetWidth;
    height = node.offsetHeight;

    // Check the current bounds to make sure we do not resize <webview>
    // outside of current constraints.
    maxWidth = this.attributes[webViewConstants.ATTRIBUTE_MAXWIDTH].getValue() | width;
    maxHeight = this.attributes[webViewConstants.ATTRIBUTE_MAXHEIGHT].getValue() | width;
    minWidth = this.attributes[webViewConstants.ATTRIBUTE_MINWIDTH].getValue() | width;
    minHeight = this.attributes[webViewConstants.ATTRIBUTE_MINHEIGHT].getValue() | width;
    minWidth = Math.min(minWidth, maxWidth);
    minHeight = Math.min(minHeight, maxHeight);
    if (!this.attributes[webViewConstants.ATTRIBUTE_AUTOSIZE].getValue() || (newWidth >= minWidth && newWidth <= maxWidth && newHeight >= minHeight && newHeight <= maxHeight)) {
      node.style.width = newWidth + 'px';
      node.style.height = newHeight + 'px';

      // Only fire the DOM event if the size of the <webview> has actually
      // changed.
      return this.dispatchEvent(webViewEvent);
    }
  };

  WebViewImpl.prototype.onElementResize = function(newSize) {
    // Dispatch the 'resize' event.
    var resizeEvent;
    resizeEvent = new Event('resize', {
      bubbles: true
    });
    resizeEvent.newWidth = newSize.width;
    resizeEvent.newHeight = newSize.height;
    this.dispatchEvent(resizeEvent);
    if (this.guestInstanceId) {
      return guestViewInternal.setSize(this.guestInstanceId, {
        normal: newSize
      });
    }
  };

  WebViewImpl.prototype.createGuest = function() {
    return guestViewInternal.createGuest(this.buildParams(), (function(_this) {
      return function(event, guestInstanceId) {
        return _this.attachWindow(guestInstanceId);
      };
    })(this));
  };

  WebViewImpl.prototype.dispatchEvent = function(webViewEvent) {
    return this.webviewNode.dispatchEvent(webViewEvent);
  };

  // Adds an 'on<event>' property on the webview, which can be used to set/unset
  // an event handler.
  WebViewImpl.prototype.setupEventProperty = function(eventName) {
    var propertyName;
    propertyName = 'on' + eventName.toLowerCase();
    return Object.defineProperty(this.webviewNode, propertyName, {
      get: (function(_this) {
        return function() {
          return _this.on[propertyName];
        };
      })(this),
      set: (function(_this) {
        return function(value) {
          if (_this.on[propertyName]) {
            _this.webviewNode.removeEventListener(eventName, _this.on[propertyName]);
          }
          _this.on[propertyName] = value;
          if (value) {
            return _this.webviewNode.addEventListener(eventName, value);
          }
        };
      })(this),
      enumerable: true
    });
  };

  // Updates state upon loadcommit.
  WebViewImpl.prototype.onLoadCommit = function(webViewEvent) {
    var newValue, oldValue;
    oldValue = this.webviewNode.getAttribute(webViewConstants.ATTRIBUTE_SRC);
    newValue = webViewEvent.url;
    if (webViewEvent.isMainFrame && (oldValue !== newValue)) {

      // Touching the src attribute triggers a navigation. To avoid
      // triggering a page reload on every guest-initiated navigation,
      // we do not handle this mutation.
      return this.attributes[webViewConstants.ATTRIBUTE_SRC].setValueIgnoreMutation(newValue);
    }
  };

  WebViewImpl.prototype.onAttach = function(storagePartitionId) {
    return this.attributes[webViewConstants.ATTRIBUTE_PARTITION].setValue(storagePartitionId);
  };

  WebViewImpl.prototype.buildParams = function() {
    var attribute, attributeName, css, elementRect, params, ref1;
    params = {
      instanceId: this.viewInstanceId,
      userAgentOverride: this.userAgentOverride
    };
    ref1 = this.attributes;
    for (attributeName in ref1) {
      if (!hasProp.call(ref1, attributeName)) continue;
      attribute = ref1[attributeName];
      params[attributeName] = attribute.getValue();
    }

    // When the WebView is not participating in layout (display:none)
    // then getBoundingClientRect() would report a width and height of 0.
    // However, in the case where the WebView has a fixed size we can
    // use that value to initially size the guest so as to avoid a relayout of
    // the on display:block.
    css = window.getComputedStyle(this.webviewNode, null);
    elementRect = this.webviewNode.getBoundingClientRect();
    params.elementWidth = parseInt(elementRect.width) || parseInt(css.getPropertyValue('width'));
    params.elementHeight = parseInt(elementRect.height) || parseInt(css.getPropertyValue('height'));
    return params;
  };

  WebViewImpl.prototype.attachWindow = function(guestInstanceId) {
    this.guestInstanceId = guestInstanceId;
    this.webContents = remote.getGuestWebContents(this.guestInstanceId);
    if (!this.internalInstanceId) {
      return true;
    }
    return guestViewInternal.attachGuest(this.internalInstanceId, this.guestInstanceId, this.buildParams());
  };

  return WebViewImpl;

})();

// Registers browser plugin <object> custom element.
registerBrowserPluginElement = function() {
  var proto;
  proto = Object.create(HTMLObjectElement.prototype);
  proto.createdCallback = function() {
    this.setAttribute('type', 'application/browser-plugin');
    this.setAttribute('id', 'browser-plugin-' + getNextId());

    // The <object> node fills in the <webview> container.
    this.style.display = 'block';
    this.style.width = '100%';
    return this.style.height = '100%';
  };
  proto.attributeChangedCallback = function(name, oldValue, newValue) {
    var internal;
    internal = v8Util.getHiddenValue(this, 'internal');
    if (!internal) {
      return;
    }
    return internal.handleBrowserPluginAttributeMutation(name, oldValue, newValue);
  };
  proto.attachedCallback = function() {
    // Load the plugin immediately.
    var unused;
    return unused = this.nonExistentAttribute;
  };
  WebViewImpl.BrowserPlugin = webFrame.registerEmbedderCustomElement('browserplugin', {
    "extends": 'object',
    prototype: proto
  });
  delete proto.createdCallback;
  delete proto.attachedCallback;
  delete proto.detachedCallback;
  return delete proto.attributeChangedCallback;
};

// Registers <webview> custom element.
registerWebViewElement = function() {
  var createBlockHandler, createNonBlockHandler, i, j, len, len1, m, methods, nonblockMethods, proto;
  proto = Object.create(HTMLObjectElement.prototype);
  proto.createdCallback = function() {
    return new WebViewImpl(this);
  };
  proto.attributeChangedCallback = function(name, oldValue, newValue) {
    var internal;
    internal = v8Util.getHiddenValue(this, 'internal');
    if (!internal) {
      return;
    }
    return internal.handleWebviewAttributeMutation(name, oldValue, newValue);
  };
  proto.detachedCallback = function() {
    var internal;
    internal = v8Util.getHiddenValue(this, 'internal');
    if (!internal) {
      return;
    }
    guestViewInternal.deregisterEvents(internal.viewInstanceId);
    internal.elementAttached = false;
    return internal.reset();
  };
  proto.attachedCallback = function() {
    var internal;
    internal = v8Util.getHiddenValue(this, 'internal');
    if (!internal) {
      return;
    }
    if (!internal.elementAttached) {
      guestViewInternal.registerEvents(internal, internal.viewInstanceId);
      internal.elementAttached = true;
      return internal.attributes[webViewConstants.ATTRIBUTE_SRC].parse();
    }
  };

  // Public-facing API methods.
  methods = [
    'getURL',
    'getTitle',
    'isLoading',
    'isWaitingForResponse',
    'stop',
    'reload',
    'reloadIgnoringCache',
    'canGoBack',
    'canGoForward',
    'canGoToOffset',
    'clearHistory',
    'goBack',
    'goForward',
    'goToIndex',
    'goToOffset',
    'isCrashed',
    'setUserAgent',
    'getUserAgent',
    'openDevTools',
    'closeDevTools',
    'isDevToolsOpened',
    'isDevToolsFocused',
    'inspectElement',
    'setAudioMuted',
    'isAudioMuted',
    'undo',
    'redo',
    'cut',
    'copy',
    'paste',
    'pasteAndMatchStyle',
    'delete',
    'selectAll',
    'unselect',
    'replace',
    'replaceMisspelling',
    'findInPage',
    'stopFindInPage',
    'getId',
    'downloadURL',
    'inspectServiceWorker',
    'print',
    'printToPDF'
  ];
  nonblockMethods = [
    'executeJavaScript',
    'insertCSS',
    'insertText',
    'send',
    'sendInputEvent',
    'setZoomFactor',
    'setZoomLevel',
    'setZoomLevelLimits',
  ];

  // Forward proto.foo* method calls to WebViewImpl.foo*.
  createBlockHandler = function(m) {
    return function() {
      var args, internal, ref1;
      args = 1 <= arguments.length ? slice.call(arguments, 0) : [];
      internal = v8Util.getHiddenValue(this, 'internal');
      return (ref1 = internal.webContents)[m].apply(ref1, args);
    };
  };
  for (i = 0, len = methods.length; i < len; i++) {
    m = methods[i];
    proto[m] = createBlockHandler(m);
  }
  createNonBlockHandler = function(m) {
    return function() {
      var args, internal;
      args = 1 <= arguments.length ? slice.call(arguments, 0) : [];
      internal = v8Util.getHiddenValue(this, 'internal');
      return ipcRenderer.send.apply(ipcRenderer, ['ATOM_BROWSER_ASYNC_CALL_TO_GUEST_VIEW', internal.guestInstanceId, m].concat(slice.call(args)));
    };
  };
  for (j = 0, len1 = nonblockMethods.length; j < len1; j++) {
    m = nonblockMethods[j];
    proto[m] = createNonBlockHandler(m);
  }

  // Deprecated.
  deprecate.rename(proto, 'getUrl', 'getURL');
  window.WebView = webFrame.registerEmbedderCustomElement('webview', {
    prototype: proto
  });

  // Delete the callbacks so developers cannot call them and produce unexpected
  // behavior.
  delete proto.createdCallback;
  delete proto.attachedCallback;
  delete proto.detachedCallback;
  return delete proto.attributeChangedCallback;
};

useCapture = true;

listener = function(event) {
  if (document.readyState === 'loading') {
    return;
  }
  registerBrowserPluginElement();
  registerWebViewElement();
  return window.removeEventListener(event.type, listener, useCapture);
};

window.addEventListener('readystatechange', listener, true);

module.exports = WebViewImpl;
