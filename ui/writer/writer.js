"use strict";

var OO = require('../../basics/oo');
var Component = require('../component');
var _ = require("../../basics/helpers");
var EventEmitter = require('../../basics/event_emitter');
var Controller = require('../../ui/controller');

var $$ = Component.$$;

function Writer() {
  Component.apply(this, arguments);

  // Mixin EventEmitter API
  EventEmitter.call(this);

  this.config = this.props.config || {};
  this.handleApplicationKeyCombos = this.handleApplicationKeyCombos.bind(this);

  var doc = this.props.doc;

  // Initialize controller
  this.controller = new Controller(doc, {
    components: this.config.components,
    commands: this.config.commands,
    // Pass custom save handling to controller
    onDocumentSave: this.props.onDocumentSave
  });

  // Register event handlers
  // -----------------

  doc.connect(this, {
    'document:changed': this.onDocumentChanged
  });

  this.controller.connect(this, {
    "selection:changed": this.onSelectionChanged
  });

  // action handlers
  this.actions({
    "switchState": this.switchState,
    "switchContext": this.switchContext
  });
}

Writer.Prototype = function() {

  // Mixin EventEmitter API
  _.extend(this, EventEmitter.prototype);

  this.getChildContext = function() {
    return {
      controller: this.controller,
    };
  };

  this.getDocument = function() {
    return this.props.doc;
  };

  // Do we want to expose the controller publicly?
  this.getController = function() {
    return this.controller;
  };

  this.willReceiveProps = function(newProps) {
    if (this.props.doc && newProps.doc !== this.props.doc) {
      this._disposeDoc();
    }
  };

  this.onSelectionChanged = function(/*sel, surface*/) {
    // no-op, should be overridden by custom writer
  };

  this.didInitialize = function(props, state) {
    /* jshint unused: false */
    // Now handle state update for the initial state
    this.handleStateUpdate(state);
  };

  // If no name is provided focused surface is returned
  this.getSurface = function(name) {
    return this.controller.getSurface(name);
  };

  this.willUpdateState = function(newState) {
    this.handleStateUpdate(newState);
  };

  this.handleStateUpdate = function() {
    // no-op, should be overridden by custom writer
  };

  this.didMount = function() {
    this.$el.on('keydown', this.handleApplicationKeyCombos);
    // Attach clipboard
    var clipboard = this.controller.getClipboard();
    clipboard.attach(this.$el[0]);
  };

  this.willUnmount = function() {
    this.$el.off('keydown');
    if (this.props.doc) {
      this._disposeDoc();
    }
  };

  this.getDocument = function() {
    return this.props.doc;
  };

  // Delegate to controller
  this.executeCommand = function(commandName) {
    return this.controller.executeCommand(commandName);
  };

  // Event handlers
  // --------------

  // return true when you handled a key combo
  this.handleApplicationKeyCombos = function(e) {
    // console.log('####', e.keyCode, e.metaKey, e.ctrlKey, e.shiftKey);
    var handled = false;

    if (e.keyCode === 27) {
      this.setState(this.getInitialState());
      handled = true;
    }
    // Save: cmd+s
    else if (e.keyCode === 83 && (e.metaKey||e.ctrlKey)) {
      this.executeCommand('save');
      handled = true;
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
  };

  this.onDocumentChanged = function(change, info) {
    // after undo/redo, also recover the stored writer state
    if (info.replay && change.after.state) {
      this.setState(change.after.state);
    }
  };

  // Action handlers
  // ---------------

  // handles 'switch-state'
  this.switchState = function(newState, options) {
    this.setState(newState);
    if (options.restoreSelection) {
      this.restoreSelection();  
    }
  };

  // handles 'switch-context'
  this.switchContext = function(contextId, options) {
    this.setState({ contextId: contextId });
    if (options.restoreSelection) {
      this.restoreSelection();  
    }
  };

  this.restoreSelection = function() {
    var surface = this.controller.getSurface('body');
    surface.rerenderDomSelection();
  };

  // Pass writer start 
  this._panelPropsFromState = function (state) {
    var props = _.omit(state, 'contextId');
    props.doc = this.props.doc;
    return props;
  };

  this.getActivePanelElement = function() {
    var ComponentClass = this.controller.getComponent(this.state.contextId);
    if (ComponentClass) {
      return $$(ComponentClass).setProps(this._panelPropsFromState(this.state));
    } else {
      console.warn("Could not find component for contextId:", this.state.contextId);
    }
  };

  this._disposeDoc = function() {
    this.props.doc.disconnect(this);
    var clipboard = this.controller.getClipboard();
    clipboard.detach(this.$el[0]);
    this.controller.dispose();
  };

};

OO.inherit(Writer, Component);

module.exports = Writer;
