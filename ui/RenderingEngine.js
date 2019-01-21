import isFunction from '../util/isFunction'
import forEach from '../util/forEach'
import uuid from '../util/uuid'
import substanceGlobals from '../util/substanceGlobals'
import DefaultDOMElement from '../dom/DefaultDOMElement'
import VirtualElement from './VirtualElement'

/*

  # Rendering Algorithm

  ## Introduction

  What makes our rendering algorithm so difficult?

  - Dependency Injection requires a (direct) parent to allow constructor
    injection, i.e. that injected dependencies are available in the constructor
    already. As a consequence a component tree must to be constructed from top
    to down.

  - The earliest time to evaluate `$$(MyComponent)`, is when it has been
    attached to an existing component. I.e., to run `MyComponent.render()` an
    instance of `MyComponent` is needed, which can only be created with an
    existing parent component.

  - In general, it is *not* possible to have a naturally descending rendering
    algorithm, i.e. a simple recursion calling `render()` and creating or
    updating Components on the way, preserving a simple stack-trace.
    Instead, it requires calling `render()` on one level, then doing comparisons
    with the existing tree to be able to reuse components, and then descend into
    the sub-tree.

  - If components are passed down via props, things get even more difficult.
    For example, consider a situation where components are passed via props:
    ```
      render($$) {
        return $$('div').append(
          $$(Wrapper, {
            foo: $$(MyComponent)
          })
        )
      }
    ```
    At the time when this component gets rendered, `MyComponent` can not be
    instantiated, as it is not known what `Wrapper` actually does with it.
    While the general approach is working from top-to-down, in this case it has
    a bottom-to-up nature, i.e., the child needs to be rendered to know what to
    do with the passed component.

    Particularly, this is problematic when the passed component has a reference:
    ```
      render($$) {
        return $$('div').append(
          $$(Wrapper, {
            foo: $$(MyComponent).ref('foo')
          })
        )
      }
    ```
    As nothing is known at the time of descending about the content of `Wrapper`
    the rendering algorithm can not tell that it ought to be preserved. For now,
    the correct way to deal with this situation is to use a reference for the
    wrapper as well:
    ```
      render($$) {
        return $$('div').append(
          $$(Wrapper, {
            foo: $$(MyComponent).ref('foo')
          }).ref('wrapper')
        )
      }
    ```

  ## Algorithm

  For a given Component `comp`:

  1. Capturing a virtual DOM
    1.1. Create a virtual DOM element by calling `comp.render()`
    1.2. Map virtual elements to existing elements
    1.3. Apply 1.1. and 1.2. recursively for every virtual Component
  2. Update `comp.el` given a virtual DOM element

  Notes:
  - 1.2. is necessary to preserve components and capture DOM updates using the
    correct instances
  - 2. can be seen as an independent task, updating one DOM given a second one.

  ## Implementation

  > TODO: flesh this out

  - Rendering happens in two stages: capture and render/update.
    In the capturing stage a VirtualComponent tree is created by calling
    `Component.render()` from top to down recursively. In the rendering stage
    DOM elements are created and updated.
  - DEBUG_RENDERING: recursive capturing is best done level by level, i.e.
    capture one VirtualComponent, and then descend into the child components.
    Unfortunately this detaches one render() call of a parent component from the
    `render()` calls of the children component. For this reason, we introduced a
    mode where the render() method is used as a vehicle to trigger recursive
    capturing.
    This would not be necessary if we were using a recursive syntax, as React
    does, i.e. the code is more like functional programming.
    While this works well for simple scenarios, the source code is getting
    harder to read control flow is necessary, e.g. for loops or if statements
  - Refs: the programmer can use ref(id) to register a reference to a child
    component. Referenced components are always reused when rerendering, i.e.
    not disposed. For other elements, there is no guarantee that the component
    and its DOM element is reused. The RenderingEngine may do so if possible,
    e.g. if the structure does not change.

  ## TODO

  - reuse unmapped elements that are compatible during rendering
  - rethink 'Forwarding Components' regarding parent-child relationship.
    ATM, there is no extra model for that hierarchy than the DOM, only
    `comp.parent` reflects the relationship correctly

  These ideas could improve the implementation:
  - remove outlets: outlets are just another way to change props.
  - try to fuse `virtualComponent._content` into virtualComponent:
    ATM, `VirtualComponent` uses a `VirtualHTMLElement`
    instance to store the result of `render()`. This makes understanding the
    virtual tree after rendering difficult, as there is another layer via
    `virtualComponent._content`.
*/
export default class RenderingEngine {
  constructor (options = {}) {
    this.componentFactory = options.componentFactory
    if (!this.componentFactory) throw new Error("'componentFactory' is mandatory")
    this.elementFactory = options.elementFactory || DefaultDOMElement.createDocument('html')
    if (!this.elementFactory) throw new Error("'elementFactory' is mandatory")
  }

  _render (comp, oldProps, oldState) {
    // let t0 = Date.now()
    let vel = _createWrappingVirtualComponent(comp)
    let state = this._createState()
    // top-level comp and virtual component are mapped per se
    state.setMapped(vel)
    state.setMapped(comp)
    if (oldProps) {
      state.setOldProps(vel, oldProps)
    }
    if (oldState) {
      state.setOldState(vel, oldState)
    }
    try {
      // capture: this calls the render() method of components, creating a
      // virtual DOM
      // console.log('### capturing...')
      // let t0 = Date.now()
      _capture(state, vel, 'forceCapture')
      // console.log('### ... finished in %s ms', Date.now()-t0)

      // console.log('### rendering...')
      // t0 = Date.now()
      _update(state, vel)
      // console.log('### ... finished in %s ms', Date.now()-t0)

      _triggerUpdate(state, vel)
    } finally {
      state.dispose()
    }
    // console.log("RenderingEngine: finished rendering in %s ms", Date.now()-t0)
  }

  // this is used together with the incremental Component API
  // TODO: we could try to generalize this to allow partial rerenderings
  // e.g. a component has a method to rerender just one element, which is then
  // applied to update an element
  _renderChild (comp, vel) {
    // HACK: to make this work with the rest of the implementation
    // we ingest a fake parent
    let state = this._createState()
    vel.parent = { _comp: comp }
    try {
      _capture(state, vel)
      _update(state, vel)
      return vel._comp
    } finally {
      state.dispose()
    }
  }

  _createState () {
    return new RenderingState(this.componentFactory, this.elementFactory)
  }

  static createContext (comp) {
    let vel = _createWrappingVirtualComponent(comp)
    return new VirtualElement.CaptureContext(vel)
  }
}

// calling comp.render() and capturing recursively
function _capture (state, vel, forceCapture) {
  if (state.isCaptured(vel)) {
    return vel
  }
  // a captured VirtualElement has a component instance attached
  let comp = vel._comp
  if (!comp) {
    comp = _create(state, vel)
    state.setNew(vel)
  }
  if (vel._isVirtualComponent) {
    let needRerender
    // NOTE: forceCapture is used for the first entrance
    // from this.render(comp) where we want to fource capturing
    // as it has already been cleared that a rerender is necessary
    if (forceCapture) {
      needRerender = true
    } else {
      // NOTE: don't ask shouldRerender if no element is there yet
      needRerender = !comp.el || comp.shouldRerender(vel.props, comp.state)
      comp.__htmlConfig__ = vel._copyHTMLConfig()
      state.setOldProps(vel, comp.props)
      state.setOldState(vel, comp.state)
      // updates prop triggering willReceiveProps
      comp._setProps(vel.props)
      if (!state.isNew(vel)) {
        state.setUpdated(vel)
      }
    }
    if (needRerender) {
      let context = new VirtualElement.CaptureContext(vel)
      let content = comp.render(context.$$)
      if (!content) {
        throw new Error('Component.render() returned nil.')
      } else if (content._isVirtualComponent) {
        // EXPERIMENTAL: allowing for forwarding components
        // content needs to have a parent for creating components
        content._isForwarded = true
        content.parent = vel
        // capture virtual DOM recursively
        // _capture(state, content)
      } else if (!content._isVirtualHTMLElement) {
        throw new Error('render() must return a plain element or a Component')
      }

      if (comp.__htmlConfig__) {
        content._mergeHTMLConfig(comp.__htmlConfig__)
      }
      if (!content._isVirtualComponent) {
        content._comp = comp
      }
      vel._content = content
      if (!state.isNew(vel) && comp.isMounted()) {
        state.setUpdated(vel)
      }
      // Mapping: map virtual elements to existing components based on refs
      // TODO: this does not yet work for forwarded components
      _prepareVirtualComponent(state, comp, content)

      // Descending
      if (substanceGlobals.DEBUG_RENDERING) {
        // in this case we use the render() function as iterating function,
        // where `$$` is a function which creates components and renders them
        // recursively. First we can create all element components that can be
        // reached without recursion
        let stack = content.children.slice(0)
        while (stack.length) {
          let child = stack.shift()
          if (state.isCaptured(child)) continue
          // virtual components are addressed via recursion, not captured here
          if (child._isVirtualComponent) continue
          if (!child._comp) {
            _create(state, child)
          }
          if (child._isVirtualHTMLElement && child.children.length > 0) {
            stack = stack.concat(child.children)
          }
          state.setCaptured(child)
        }
        // ATTENTION: this is necessary for DescendingContext
        // TODO: document why
        if (!content._isForwarded) {
          state.setCaptured(content)
        }
        // then we run comp.render($$) with a special $$ that captures
        // VirtualComponents recursively
        let descendingContext = new DescendingContext(state, context)
        while (descendingContext.hasPendingCaptures()) {
          descendingContext.reset()
          comp.render(descendingContext.$$)
        }
        // capture injected components recursively
        // for the case that the owner is not re-rendered
        for (let child of context.injectedComponents) {
          _capture(state, child)
        }
        // TODO: this can be improved. It would be better if _capture was called
        // by DescendingContext() then the forwarded component would be rendered
        // during the render() call of the forwarding component
        if (content._isForwarded) {
          _capture(state, content)
        }
      } else {
        // ATTENTION: without DEBUG_RENDERING enabled the content is captured
        // outside of the `render()` call stack i.e. `render()` has finished
        // already and provided a virtual element. Children component are
        // rendered as part of this recursion, i.e. in the stack trace there
        // will be `RenderingEngine._capture()` only
        _capture(state, content)
      }
      if (content._isForwarded) {
        content._comp._isForwarded = true
      }
    } else {
      state.setSkipped(vel)
    }
  } else if (vel._isVirtualHTMLElement) {
    for (let child of vel.children) {
      _capture(state, child)
    }
  }
  state.setCaptured(vel)
  return vel
}

// called to initialize a captured component, i.e. creating a Component instance
// from a VirtualElement
function _create (state, vel) {
  let comp = vel._comp
  console.assert(!comp, 'Component instance should not exist when this method is used.')
  let parent = vel.parent._comp
  // making sure the parent components have been instantiated
  if (!parent) {
    parent = _create(state, vel.parent)
  }
  if (vel._isVirtualComponent) {
    console.assert(parent, 'A Component should have a parent.')
    comp = state.componentFactory.createComponent(vel.ComponentClass, parent, vel.props)
    // HACK: making sure that we have the right props
    vel.props = comp.props
    comp.__htmlConfig__ = vel._copyHTMLConfig()
  } else if (vel._isVirtualHTMLElement) {
    comp = state.componentFactory.createElementComponent(parent, vel)
  } else if (vel._isVirtualTextNode) {
    comp = state.componentFactory.createTextNodeComponent(parent, vel)
  }
  if (vel._ref) {
    comp._ref = vel._ref
  }
  if (vel._owner) {
    comp._owner = vel._owner._comp
  }
  vel._comp = comp
  return comp
}

/*
  Prepares a new virtual component by comparing it with the old version.

  It sets the _comp references in the new version where its ancestors
  can be mapped to corresponding virtual components in the old version.
*/
function _prepareVirtualComponent (state, comp, vc) {
  // refs are those ref'd using $$().ref()
  let newRefs = {}
  // foreignRefs are refs of those components which are passed via props
  let foreignRefs = {}
  // all other components which are not ref'd stored via a derived key based on trace
  let otherComponents = {}

  // TODO: iron this out.
  // refs are stored on the context. It would be cleaner if they were on the
  // VirtualComponent. Where vc._owner would need to be a VirtualComponent and
  // not a component.
  if (vc._context) {
    newRefs = vc._context.refs
    foreignRefs = vc._context.foreignRefs
    otherComponents = _extractOtherComponentRefs(vc._context, 'virtual')
  }
  let oldRefs = comp.refs
  let oldForeignRefs = comp.__foreignRefs__
  let oldOtherComponents = comp.__otherComponents__ || {}

  // map virtual components to existing ones
  forEach(newRefs, (vc, ref) => {
    let comp = oldRefs[ref]
    if (comp) _mapComponents(state, comp, vc)
  })
  forEach(foreignRefs, (vc, ref) => {
    let comp = oldForeignRefs[ref]
    if (comp) _mapComponents(state, comp, vc)
  })
  forEach(otherComponents, (vc, ref) => {
    let comp = oldOtherComponents[ref]
    if (comp) _mapComponents(state, comp, vc)
  })
}

/*
  This tries to map the virtual component to existing component instances
  by looking at the old and new refs, making sure that the element type is
  compatible.
*/
function _mapComponents (state, comp, vc) {
  if (!comp && !vc) return true
  if (!comp || !vc) return false
  // Stop if one them has been mapped already
  // or the virtual element has its own component already
  // or if virtual element and component do not match semantically
  // Note: the owner component is mapped at very first, so this
  // recursion will stop at the owner at the latest.
  if (state.isMapped(vc) || state.isMapped(comp)) {
    // if one of them has been mapped, then the comp must be equal,
    // otherwise this is an invalid map
    // TODO: could it possible that they are different?
    return vc._comp === comp
  }
  // TODO: this is also called for the root component, which is not necessary.
  // This branch is covering the case, but it could be done more explicitly
  if (vc._comp) {
    if (vc._comp === comp) {
      state.setMapped(vc)
      state.setMapped(comp)
      return true
    } else {
      return false
    }
  }
  if (!_isOfSameType(comp, vc)) {
    return false
  }

  vc._comp = comp
  state.setMapped(vc)
  state.setMapped(comp)

  let canMapParent
  let parent = comp.getParent()
  if (vc.parent) {
    canMapParent = _mapComponents(state, parent, vc.parent)
  // to be able to support implicit retaining of elements
  // we need to propagate mapping through the 'preliminary' parent chain
  // i.e. not taking the real parents as rendered, but the Components into which
  // we have passed children (via vel.append() or vel.outlet().append())
  } else if (vc._preliminaryParent) {
    while (parent && parent._isElementComponent) {
      parent = parent.getParent()
    }
    canMapParent = _mapComponents(state, parent, vc._preliminaryParent)
  }
  if (!canMapParent) {
    state.setRelocated(vc)
    state.setRelocated(comp)
  }
  return canMapParent
}

function _isOfSameType (comp, vc) {
  return (
    (comp._isElementComponent && vc._isVirtualHTMLElement) ||
    (comp._isComponent && vc._isVirtualComponent && comp.constructor === vc.ComponentClass) ||
    (comp._isTextNodeComponent && vc._isVirtualTextNode)
  )
}

// Update a DOM element by applying changes derived from a given virtual element
function _update (state, vel) {
  if (state.isSkipped(vel)) return
  // console.log('... rendering', vel._ref)

  // HACK: workaround for a problem found in DEBUG_RENDERING mode
  // situation: a grand-parent injects via props a child component into a parent
  // component, which does render the children only in certain states (e.g. showChild=true|false)
  // changing the state from hide to show on the parent component, caused errors here
  // It would be more consistent to do this during the capturing phase of
  // vel._preliminaryParent, i.e. the one that has appends injected component.
  // TODO: decide if this really a HACK
  if (!vel._comp) {
    if (vel._ref && vel._preliminaryParent !== vel._owner) {
      _capture(state, vel)
    }
  }

  let comp = vel._comp
  console.assert(comp && comp._isComponent, 'A captured VirtualElement must have a component instance attached.')

  // VirtualComponents apply changes to its content element
  // ATTENTION: we have included the render logic for VirtualComponents into
  // the general _update() method to reduce the number of call stacks.
  // However, this is slightly confusing.
  if (vel._isVirtualComponent) {
    _update(state, vel._content)

    // store refs and foreignRefs
    const context = vel._content._context
    let refs = {}
    let foreignRefs = {}
    forEach(context.refs, (vel, ref) => {
      refs[ref] = vel._comp
    })
    forEach(context.foreignRefs, (vel, ref) => {
      foreignRefs[ref] = vel._comp
    })
    let otherComponents = _extractOtherComponentRefs(context)
    comp.refs = refs
    comp.__foreignRefs__ = foreignRefs
    comp.__otherComponents__ = otherComponents

    // using the element of the forwarded component as element for this component
    if (vel._content._isForwarded) {
      let forwardedComp = vel._content._comp
      // TODO: is this really the correct time to call didMount? shouldn't this
      // be called when processed by the parent?
      // TODO: this will not work with multiple forwarded components
      if (!comp.el) {
        comp.el = forwardedComp.el
        forwardedComp.triggerDidMount()
        comp.triggerDidMount()
      } else {
        // EXPERIMENTAL: the forwarded comp has been updated
        let oldForwardedComp = comp.el._comp
        if (oldForwardedComp !== forwardedComp) {
          oldForwardedComp.triggerDispose()
          comp.el.parentNode.replaceChild(comp.el, forwardedComp.el)
          comp.el = forwardedComp.el
          forwardedComp.triggerDidMount()
        }
      }
    }
    return
  }

  // render the element
  if (!comp.el) {
    comp.el = _createElement(state, vel)
    comp.el._comp = comp
  }
  // TODO: shouldn't this be called in else-branch of previous if statement?
  _updateElement(comp, vel)

  // structural updates are necessary only for HTML elements (without innerHTML)
  if (vel._isVirtualHTMLElement && !vel.hasInnerHTML()) {
    let newChildren = vel.children
    let oldComp, virtualComp, newComp
    let pos1 = 0; let pos2 = 0

    // HACK: removing all childNodes that are not owned by a component
    // this happened in Edge every 1s. Don't know why.
    // With this implementation all external DOM mutations will be eliminated
    let _childNodes = comp.el.getChildNodes()
    let oldChildren = []
    _childNodes.forEach(function (node) {
      let childComp = node._comp
      // EXPERIMENTAL: here we need to resolve the forwarding component,
      // which can be resolved from the owner chain
      while (childComp && childComp._isForwarded) {
        childComp = childComp._owner
      }
      // TODO: to allow mounting a prerendered DOM element
      // we would need to allow to 'take ownership' instead of removing
      // the element. This being a special situation, we should only
      // do that when mounting
      // remove orphaned nodes and relocated components
      if (!childComp || state.isRelocated(childComp)) {
        comp.el.removeChild(node)
      } else {
        oldChildren.push(childComp)
      }
    })

    while (pos1 < oldChildren.length || pos2 < newChildren.length) {
      // skip detached components
      // Note: components get detached when preserved nodes
      // are found in a swapped order. Then the only way is
      // to detach one of them from the DOM, and reinsert it later at the new
      // position
      do {
        oldComp = oldChildren[pos1++]
      } while (oldComp && (state.isDetached(oldComp)))

      virtualComp = newChildren[pos2++]
      // remove remaining old ones if no new one is left
      if (oldComp && !virtualComp) {
        while (oldComp) {
          _removeChild(state, comp, oldComp)
          oldComp = oldChildren[pos1++]
        }
        break
      }

      // reuse TextNodes to avoid unnecesary DOM manipulations
      if (oldComp && oldComp.el.isTextNode() &&
          virtualComp && virtualComp._isVirtualTextNode &&
          oldComp.el.textContent === virtualComp.text) {
        continue
      }

      // update virtual component recursively
      if (!state.isRendered(virtualComp)) {
        _update(state, virtualComp)
      }

      newComp = virtualComp._comp

      // nothing more to do if components are equal, i.e. have been mapped
      if (newComp === oldComp) {
        console.assert(state.isMapped(oldComp) && state.isMapped(newComp))
        continue
      }

      // update the parent for relocated components
      // ATTENTION: relocating a component does not update its context
      if (state.isRelocated(newComp)) {
        newComp._setParent(comp)
      }

      console.assert(newComp, 'Component instance should now be available.')

      // append remaining new ones if no old one is left
      if (virtualComp && !oldComp) {
        _appendChild(state, comp, newComp)
        continue
      // Differential update
      } else if (state.isMapped(newComp)) {
        if (state.isMapped(oldComp)) {
          // the order of elements with ref has changed
          state.setDetached(oldComp)
          _removeChild(state, comp, oldComp)
          pos2--
        // the old one could not be mapped, thus can be removed
        } else {
          _removeChild(state, comp, oldComp)
          pos2--
        }
      } else if (state.isMapped(oldComp)) {
        _insertChildBefore(state, comp, newComp, oldComp)
        pos1--
      } else {
        // both elements are not mapped
        // TODO: we could try to reuse components if they are of same type
        // However, this needs a better mapping strategy, not only
        // based on refs.
        _replaceChild(state, comp, oldComp, newComp)
      }
    }
  }

  state.setRendered(vel)
}

function _extractOtherComponentRefs (context, virtual) {
  let idCounts = new Map()
  let refs = {}
  for (let vc of context.components) {
    // TODO: also skip those components which are not appended to the current comp
    if (vc._ref) continue
    let ref = _getVirtualComponentTrace(vc)
    // disambiguate generated refs by appending '@<count>'
    if (idCounts.has(ref)) {
      let count = idCounts.get(ref) + 1
      idCounts.set(ref, count)
      ref = ref + '@' + count
    } else {
      idCounts.set(ref, 1)
    }
    if (virtual) {
      refs[ref] = vc
    } else {
      refs[ref] = vc._comp
    }
  }
  return refs
}

function _getVirtualComponentTrace (vc) {
  // TODO: how to create a string from the class name?
  let frags = [vc.ComponentClass.name]
  if (!vc._isForwarded) {
    let parent = vc.getParent()
    while (parent) {
      // ATTENTION if the vc has been appended then its ancestors are all virtual HTML elements
      console.assert(parent._isVirtualHTMLElement)
      frags.unshift(parent.tagName)
      parent = parent.parent
    }
  }
  return frags.join('/')
}

function _triggerUpdate (state, vel) {
  if (vel._isVirtualComponent) {
    if (!state.isSkipped(vel)) {
      vel._content.children.forEach(_triggerUpdate.bind(null, state))
    }
    if (state.isUpdated(vel)) {
      vel._comp.didUpdate(state.getOldProps(vel), state.getOldState(vel))
    }
  } else if (vel._isVirtualHTMLElement) {
    vel.children.forEach(_triggerUpdate.bind(null, state))
  }
}

function _appendChild (state, parent, child) {
  parent.el.appendChild(child.el)
  _triggerDidMount(state, parent, child)
}

function _replaceChild (state, parent, oldChild, newChild) {
  parent.el.replaceChild(oldChild.el, newChild.el)
  if (!state.isDetached(oldChild)) {
    oldChild.triggerDispose()
  }
  _triggerDidMount(state, parent, newChild)
}

function _insertChildBefore (state, parent, child, before) {
  parent.el.insertBefore(child.el, before.el)
  _triggerDidMount(state, parent, child)
}

function _removeChild (state, parent, child) {
  parent.el.removeChild(child.el)
  if (!state.isDetached(child)) {
    child.triggerDispose()
  }
}

function _triggerDidMount (state, parent, child) {
  if (!state.isDetached(child) &&
      parent.isMounted() && !child.isMounted()) {
    child.triggerDidMount(true)
  }
}

function _createElement (state, vel) {
  let el
  if (vel._isVirtualTextNode) {
    el = state.elementFactory.createTextNode(vel.text)
  } else {
    el = state.elementFactory.createElement(vel.tagName)
  }
  return el
}

function _updateElement (comp, vel) {
  if (comp._isTextNodeComponent) {
    comp.setTextContent(vel.text)
    return
  }
  let el = comp.el
  console.assert(el, "Component's element should exist at this point.")
  let tagName = el.getTagName()
  if (vel.tagName.toLowerCase() !== tagName) {
    el.setTagName(vel.tagName)
  }
  _updateHash({
    oldHash: el.getAttributes(),
    newHash: vel.getAttributes(),
    update: function (key, val) {
      el.setAttribute(key, val)
    },
    remove: function (key) {
      el.removeAttribute(key)
    }
  })
  _updateHash({
    oldHash: el.htmlProps,
    newHash: vel.htmlProps,
    update: function (key, val) {
      el.setProperty(key, val)
    },
    remove: function (key) {
      el.removeProperty(key)
    }
  })
  _updateListeners({
    el: el,
    oldListeners: el.getEventListeners(),
    newListeners: vel.getEventListeners()
  })

  // special treatment of HTML elements having custom innerHTML
  if (vel.hasInnerHTML()) {
    if (!el._hasInnerHTML) {
      el.empty()
      el.setInnerHTML(vel.getInnerHTML())
    } else {
      let oldInnerHTML = el.getInnerHTML()
      let newInnerHTML = vel.getInnerHTML()
      if (oldInnerHTML !== newInnerHTML) {
        el.setInnerHTML(newInnerHTML)
      }
    }
    el._hasInnerHTML = true
  }
}

function _hashGet (hash, key) {
  if (hash instanceof Map) {
    return hash.get(key)
  } else {
    return hash[key]
  }
}

function _updateHash (args) {
  const newHash = args.newHash
  const oldHash = args.oldHash || {}
  const update = args.update
  const remove = args.remove
  let updatedKeys = {}
  for (let key in newHash) {
    if (newHash.hasOwnProperty(key)) {
      let oldVal = _hashGet(oldHash, key)
      let newVal = _hashGet(newHash, key)
      updatedKeys[key] = true
      if (oldVal !== newVal) {
        update(key, newVal)
      }
    }
  }
  // HACK: we have a horrible mixture of Objects and
  // Maps here
  if (isFunction(oldHash.keys) && oldHash.size > 0) {
    let keys = Array.from(oldHash.keys())
    keys.forEach((key) => {
      if (!updatedKeys[key]) {
        remove(key)
      }
    })
  } else {
    for (let key in oldHash) {
      if (oldHash.hasOwnProperty(key) && !updatedKeys[key]) {
        remove(key)
      }
    }
  }
}

function _updateListeners (args) {
  let el = args.el
  // NOTE: considering the low number of listeners
  // it is quicker to just remove all
  // and add again instead of computing the minimal update
  let newListeners = args.newListeners || []
  el.removeAllEventListeners()
  for (let i = 0; i < newListeners.length; i++) {
    el.addEventListener(newListeners[i])
  }
}

/*
  Descending Context used by RenderingEngine
*/
class DescendingContext {
  constructor (state, captureContext) {
    this.state = state
    this.owner = captureContext.owner
    this.refs = {}
    this.foreignRefs = {}
    this.elements = captureContext.elements
    this.pos = 0
    this.updates = captureContext.components.length
    this.remaining = this.updates
    this.injectedComponents = captureContext.injectedComponents

    this.$$ = this._createComponent.bind(this)
  }

  _createComponent () {
    let state = this.state
    let vel = this.elements[this.pos++]
    // only capture VirtualComponent's with a captured parent
    // all others have been captured at this point already
    // or will either be captured by a different owner
    if (!state.isCaptured(vel) && vel._isVirtualComponent &&
         vel.parent && state.isCaptured(vel.parent)) {
      _capture(state, vel)
      this.updates++
      this.remaining--
    }
    // Note: we return a new VirtualElement so that the render method does work
    // as expected.
    // TODO: instead of creating a new VirtualElement each time, we could return
    // an immutable wrapper for the already recorded element.
    vel = VirtualElement.createElement.apply(this, arguments)
    // these variables need to be set to make the 'ref()' API work
    vel._context = this
    vel._owner = this.owner
    // Note: important to deactivate these methods as otherwise the captured
    // element will be damaged when calling el.append()
    vel._attach = function () {}
    vel._detach = function () {}
    return vel
  }

  hasPendingCaptures () {
    return this.updates > 0 && this.remaining > 0
  }

  reset () {
    this.pos = 0
    this.updates = 0
    this.refs = {}
  }

  _ancestorsReady (vel) {
    while (vel) {
      if (this.state.isCaptured(vel) ||
          // TODO: iron this out
          vel === this.owner || vel === this.owner._content) {
        return true
      }
      vel = vel.parent
    }
    return false
  }
}

function _createWrappingVirtualComponent (comp) {
  let vel = new VirtualElement.Component(comp.constructor)
  vel._comp = comp
  if (comp.__htmlConfig__) {
    vel._mergeHTMLConfig(comp.__htmlConfig__)
  }
  return vel
}

class RenderingState {
  constructor (componentFactory, elementFactory) {
    this.componentFactory = componentFactory
    this.elementFactory = elementFactory
    this.polluted = []
    this.id = '__' + uuid()
  }

  dispose () {
    let id = this.id
    this.polluted.forEach(function (obj) {
      delete obj[id]
    })
  }

  set (obj, key, val) {
    let info = obj[this.id]
    if (!info) {
      info = {}
      obj[this.id] = info
      this.polluted.push(obj)
    }
    info[key] = val
  }

  get (obj, key) {
    let info = obj[this.id]
    if (info) {
      return info[key]
    }
  }

  setMapped (c) {
    this.set(c, 'mapped', true)
  }

  isMapped (c) {
    return Boolean(this.get(c, 'mapped'))
  }

  // 'relocated' means a node with ref
  // has been attached to a new parent node
  setRelocated (c) {
    this.set(c, 'relocated', true)
  }

  isRelocated (c) {
    return Boolean(this.get(c, 'relocated'))
  }

  setDetached (c) {
    this.set(c, 'detached', true)
  }

  isDetached (c) {
    return Boolean(this.get(c, 'detached'))
  }

  setCaptured (vc, val = true) {
    this.set(vc, 'captured', val)
  }

  isCaptured (vc) {
    return Boolean(this.get(vc, 'captured'))
  }

  setNew (vc) {
    this.set(vc, 'created', true)
  }

  isNew (vc) {
    return Boolean(this.get(vc, 'created'))
  }

  setUpdated (vc) {
    this.set(vc, 'updated', true)
  }

  isUpdated (vc) {
    return Boolean(this.get(vc, 'updated'))
  }

  setSkipped (vc) {
    this.set(vc, 'skipped', true)
  }

  isSkipped (vc) {
    return Boolean(this.get(vc, 'skipped'))
  }

  setRendered (vc) {
    this.set(vc, 'rendered', true)
  }

  isRendered (vc) {
    return Boolean(this.get(vc, 'rendered'))
  }

  setOldProps (vc, oldProps) {
    this.set(vc, 'oldProps', oldProps)
  }

  getOldProps (vc) {
    return this.get(vc, 'oldProps')
  }

  setOldState (vc, oldState) {
    this.set(vc, 'oldState', oldState)
  }

  getOldState (vc) {
    return this.get(vc, 'oldState')
  }
}

RenderingEngine._internal = {
  _capture: _capture,
  _wrap: _createWrappingVirtualComponent
}
