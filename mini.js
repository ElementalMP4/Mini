const Mini = (() => {
    const TEXT = Symbol("text");
    const EMPTY = Symbol("empty");

    let rootComponent = null;
    let rootElement = null;
    let rootVNode = null;
    let currentInstance = null;
    let hookIndex = 0;
    let routeChangeListenerAttached = false;
    let scheduled = false;

    /** Flattens nested children and removes non-renderable booleans/nullish values. */
    function flatten(items) {
        return items.flat(Infinity).filter(child =>
            child !== false && child !== true && child !== null && child !== undefined
        );
    }

    /** Normalizes a child into a vnode (text, empty placeholder, or vnode passthrough). */
    function normalize(child) {
        if (child === false || child === true || child === null || child === undefined)
            return newVnode(EMPTY, {});
        if (typeof child === "string" || typeof child === "number")
            return newVnode(TEXT, { nodeValue: String(child) });
        return child;
    }

    /** Creates a vnode with normalized children and metadata. */
    function newVnode(type, props = {}, ...children) {
        const safeProps = props || {};
        const normalizedChildren = flatten(children).map(normalize);
        return {
            type,
            props: { ...safeProps, children: normalizedChildren },
            key: safeProps.key ?? null,
            dom: null,
            instance: null
        };
    }

    /** Public vnode factory used by components and tag helpers. */
    function vnode(type, props = {}, ...children) {
        return newVnode(type, props, ...children);
    }

    /** Applies a single prop diff to a DOM element. */
    function setProp(dom, key, value, oldValue) {
        if (key === "children" || key === "key") return;

        if (key === "class" || key === "className") {
            dom.className = value || "";
            return;
        }

        if (key === "style" && typeof value === "object") {
            Object.assign(dom.style, value || {});
            return;
        }

        if (key === "ref" && typeof value === "function") {
            value(dom);
            return;
        }

        if (key.startsWith("on") && typeof value === "function") {
            const eventName = key.slice(2).toLowerCase();
            if (oldValue) dom.removeEventListener(eventName, oldValue);
            dom.addEventListener(eventName, value);
            return;
        }

        if (value === false || value === null || value === undefined) {
            dom.removeAttribute(key);
            // Also clear the DOM property if it exists (e.g. `input.disabled = ""`).
            if (key in dom) {
                try { dom[key] = ""; } catch (_) { }
            }
            return;
        }

        // value / checked must be set as properties — setAttribute would give us
        // strings, which breaks controlled inputs.
        if (key === "value" || key === "checked") {
            if (dom[key] !== value) dom[key] = value;
            return;
        }

        if (value === true) dom.setAttribute(key, "");
        else dom.setAttribute(key, String(value));
    }

    /** Reconciles element props by applying changed/removed keys. */
    function updateProps(dom, oldProps = {}, newProps = {}) {
        const keys = new Set([...Object.keys(oldProps), ...Object.keys(newProps)]);
        keys.forEach(key => {
            const oldValue = oldProps[key];
            const newValue = newProps[key];
            if (oldValue !== newValue) setProp(dom, key, newValue, oldValue);
        });
    }

    /** Creates and returns real DOM for a vnode tree. */
    function createDom(vNode) {
        if (vNode.type === EMPTY) {
            vNode.dom = document.createComment("empty");
            return vNode.dom;
        }

        if (vNode.type === TEXT) {
            vNode.dom = document.createTextNode(vNode.props.nodeValue);
            return vNode.dom;
        }

        if (typeof vNode.type === "function") {
            const instance = vNode.instance || {
                hooks: [],
                child: null,
                type: vNode.type,
                key: vNode.key
            };
            vNode.instance = instance;

            currentInstance = instance;
            hookIndex = 0;

            const childVNode = normalize(vNode.type(vNode.props));
            instance.child = childVNode;
            const dom = createDom(childVNode);
            vNode.dom = dom;

            currentInstance = null;
            return dom;
        }

        const dom = document.createElement(vNode.type);
        vNode.dom = dom;
        updateProps(dom, {}, vNode.props);
        vNode.props.children.forEach(child => dom.appendChild(createDom(child)));
        return dom;
    }

    /** Returns true when two vnodes cannot be patched in place. */
    function changed(a, b) {
        return !a || !b
            || a.type !== b.type
            || (a.key !== b.key && (a.key !== null || b.key !== null));
    }

    /** Runs cleanup callbacks for any effect hooks on an instance. */
    function cleanupHooks(hooks = []) {
        hooks.forEach(hook => {
            if (hook && typeof hook.cleanup === "function") {
                try {
                    hook.cleanup();
                } catch (_) { }
            }
        });
    }

    /** Recursively unmounts a vnode and runs component cleanup. */
    function unmountVNode(vNode) {
        if (!vNode) return;

        if (typeof vNode.type === "function") {
            const instance = vNode.instance;
            if (instance) {
                cleanupHooks(instance.hooks);
                unmountVNode(instance.child);
            }
            return;
        }

        const children = vNode.props?.children || [];
        children.forEach(child => unmountVNode(child));
    }

    /** Patches old vnode into new vnode and syncs DOM under parent. */
    function patch(parentDom, oldVNode, newVNode, index = 0) {
        newVNode = normalize(newVNode);
        const existingDom = oldVNode?.dom || parentDom.childNodes[index];

        if (!oldVNode) {
            parentDom.appendChild(createDom(newVNode));
            return newVNode;
        }

        if (!newVNode) {
            unmountVNode(oldVNode);
            if (existingDom) parentDom.removeChild(existingDom);
            return null;
        }

        if (changed(oldVNode, newVNode)) {
            unmountVNode(oldVNode);
            const newDom = createDom(newVNode);
            if (existingDom) parentDom.replaceChild(newDom, existingDom);
            else parentDom.appendChild(newDom);
            return newVNode;
        }

        newVNode.dom = oldVNode.dom;

        if (newVNode.type === TEXT) {
            if (oldVNode.props.nodeValue !== newVNode.props.nodeValue) {
                newVNode.dom.nodeValue = newVNode.props.nodeValue;
            }
            return newVNode;
        }

        if (newVNode.type === EMPTY) return newVNode;

        if (typeof newVNode.type === "function") {
            const instance = oldVNode.instance;
            newVNode.instance = instance;
            currentInstance = instance;
            hookIndex = 0;

            const childVNode = normalize(newVNode.type(newVNode.props));
            instance.child = patch(parentDom, instance.child, childVNode, index);
            newVNode.dom = instance.child.dom;

            currentInstance = null;
            return newVNode;
        }

        updateProps(newVNode.dom, oldVNode.props, newVNode.props);
        patchChildren(newVNode.dom, oldVNode.props.children || [], newVNode.props.children || []);
        return newVNode;
    }

    /** Reconciles child lists using keyed and unkeyed matching. */
    function patchChildren(parentDom, oldChildren, newChildren) {
        const oldKeyed = new Map();
        const oldUnkeyed = [];

        oldChildren.forEach(child => {
            if (child?.key !== null && child?.key !== undefined)
                oldKeyed.set(child.key, child);
            else
                oldUnkeyed.push(child);
        });

        let unkeyedIndex = 0;
        const patchedChildren = [];

        newChildren.forEach((newChild, newIndex) => {
            const oldMatch = newChild.key !== null && newChild.key !== undefined
                ? oldKeyed.get(newChild.key)
                : oldUnkeyed[unkeyedIndex++];

            const patched = patch(parentDom, oldMatch, newChild, newIndex);
            patchedChildren.push(patched);

            const wantedDom = parentDom.childNodes[newIndex];
            if (patched?.dom && patched.dom !== wantedDom) {
                parentDom.insertBefore(patched.dom, wantedDom || null);
            }
        });

        oldChildren.forEach(oldChild => {
            const stillExists = patchedChildren.some(
                child => child === oldChild || child?.dom === oldChild?.dom
            );
            if (!stillExists && oldChild?.dom?.parentNode === parentDom) {
                unmountVNode(oldChild);
                parentDom.removeChild(oldChild.dom);
            }
        });
    }

    /** Queues a single microtask render for batched updates. */
    function scheduleRender() {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            renderRoot();
        });
    }

    /** Stores component-local state and returns value plus setter. */
    function useState(initialValue) {
        const instance = currentInstance;
        const index = hookIndex;

        if (!instance) throw new Error("useState must be called inside a component.");

        if (instance.hooks[index] === undefined) {
            instance.hooks[index] = typeof initialValue === "function"
                ? initialValue()
                : initialValue;
        }

        function setState(nextValue) {
            const oldValue = instance.hooks[index];
            const next = typeof nextValue === "function" ? nextValue(oldValue) : nextValue;
            if (Object.is(oldValue, next)) return;
            instance.hooks[index] = next;
            scheduleRender();
        }

        const value = instance.hooks[index];
        hookIndex++;
        return [value, setState];
    }

    /** Convenience hook for boolean state with a toggle action. */
    function useToggle(initialValue = false) {
        const [value, setValue] = useState(initialValue);
        return [value, () => setValue(v => !v), setValue];
    }

    /** Runs side effects after render when dependencies change. */
    function useEffect(effect, deps) {
        const instance = currentInstance;
        if (!instance) throw new Error("useEffect must be called inside a component.");
        const index = hookIndex;
        const old = instance.hooks[index];

        const changedDeps = !old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps[i]));

        if (changedDeps) {
            old?.cleanup?.();
            queueMicrotask(() => {
                const cleanup = effect();
                instance.hooks[index] = { deps, cleanup };
            });
        }

        hookIndex++;
    }

    /** Creates a tiny observable store with set/get/subscribe. */
    function createStore(initialState = {}) {
        let state = initialState;
        const listeners = new Set();

        return {
            getState: () => state,

            setState(update) {
                state = typeof update === "function"
                    ? update(state)
                    : { ...state, ...update };
                listeners.forEach(listener => listener(state));
            },

            subscribe(listener) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        };
    }

    /** Subscribes to a store and returns selected state snapshots. */
    function useStore(store, selector = state => state) {
        const [snapshot, setSnapshot] = useState(() => selector(store.getState()));

        useEffect(() => store.subscribe(nextState => {
            const selected = selector(nextState);
            setSnapshot(old => Object.is(old, selected) ? old : selected);
        }), [store]);

        return snapshot;
    }

    /** Navigates via hash routing and triggers rerender as needed. */
    function navigate(path) {
        if (location.hash.slice(1) !== path) location.hash = path;
        else scheduleRender();
    }

    /** Returns the current hash path or root. */
    function getPath() {
        return location.hash.slice(1) || "/";
    }

    /** Resolves a route component for the current path. */
    function Router({ routes, fallback }) {
        const path = getPath();
        const screen = routes[path] || fallback || routes["/"];

        return screen
            ? vnode(screen, { key: path, path, navigate })
            : vnode("div", {}, "No route found");
    }

    /** Mounts the root component into a container and starts routing listener. */
    function render(component, container) {
        rootComponent = component;
        rootElement = container;

        if (!routeChangeListenerAttached) {
            window.addEventListener("hashchange", scheduleRender);
            routeChangeListenerAttached = true;
        }

        renderRoot();
    }

    /** Renders and patches the current root component tree. */
    function renderRoot() {
        if (!rootComponent || !rootElement) return;
        const nextVNode = normalize(vnode(rootComponent, {}));
        rootVNode = patch(rootElement, rootVNode, nextVNode, 0);
    }

    /**
     * Convenience wrappers for common HTML tags. Each is an alias for vnode():
     *
     *   Mini.div({ class: "card" }, Mini.p({}, "Hello"))
     *   // is equivalent to:
     *   Mini.vnode("div", { class: "card" }, Mini.vnode("p", {}, "Hello"))
     */
    const tags = [
        "div", "main", "section", "header", "footer", "button", "span", "strong", "p", "input", "textarea", "form", "small", "img", "hr",
        "h1", "h2", "h3", "label", "select", "option", "canvas", "aside", "a"
    ];

    const api = { vnode, render, useState, useToggle, useEffect, createStore, useStore, navigate, Router };
    tags.forEach(tag => api[tag] = (props, ...children) => vnode(tag, props, ...children));
    return api;

})();

export default Mini;