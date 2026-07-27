/*
 * Section drawing overlay for the hall editor.
 *
 * Sections are first-class, dynamically-named/priced areas. Each is stored as a polygon (points in
 * the same canvas-pixel space as seats), so any shape — rectangle, triangle, or an irregular
 * free-form boundary — is representable without shape-specific code. The admin can:
 *   - toggle "Edit sections" mode (so section editing never fights seat editing);
 *   - add an adjustable rectangle preset, or free-draw a polygon vertex by vertex;
 *   - drag the whole section or any single vertex;
 *   - set name, booking mode (SEATED / GENERAL_ADMISSION), price, currency, capacity and colour;
 *   - delete a section.
 * Sections are published on window.HallSectionEditor so the seat editor folds them into its Save
 * payload and its 2D/3D bridge snapshot.
 */
(function () {
    "use strict";

    var canvas = document.getElementById("seatCanvas");
    if (!canvas) { return; }

    var SVG_NS = "http://www.w3.org/2000/svg";
    var PALETTE = ["#2E75DC", "#9A5CF5", "#23A094", "#E0803B", "#D8574F", "#3FA34D", "#B4497E", "#5C6BC0"];

    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "section-layer");
    svg.style.pointerEvents = "none";
    canvas.insertBefore(svg, canvas.firstChild);

    var sections = [];
    var selected = null;
    var editing = false;         // section-edit mode on/off
    var draft = null;            // in-progress free-draw polygon
    var nextDraftKey = 1;

    // --- DOM controls --------------------------------------------------------
    var btnMode = document.getElementById("btnSectionMode");
    var tools = document.getElementById("sectionTools");
    var btnRect = document.getElementById("btnSectionRect");
    var btnDraw = document.getElementById("btnSectionDraw");
    var btnFinish = document.getElementById("btnSectionFinish");
    var btnDel = document.getElementById("btnSectionDelete");
    var inspector = document.getElementById("sectionInspector");
    var inName = document.getElementById("sxName");
    var inMode = document.getElementById("sxMode");
    var inPrice = document.getElementById("sxPrice");
    var inCurrency = document.getElementById("sxCurrency");
    var inCapacity = document.getElementById("sxCapacity");
    var capField = document.getElementById("sxCapacityField");
    var inColor = document.getElementById("sxColor");
    var statusEl = document.getElementById("sectionStatus");

    // --- Load existing sections from the embedded JSON -----------------------
    var dataEl = document.getElementById("sectionsData");
    if (dataEl && dataEl.textContent.trim()) {
        try {
            JSON.parse(dataEl.textContent).forEach(function (s) {
                sections.push(fromServer(s));
            });
        } catch (e) { /* ignore malformed */ }
    }

    function fromServer(s) {
        return {
            key: s.id != null ? "section:" + s.id : "sdraft:" + nextDraftKey++,
            id: s.id != null ? s.id : null,
            name: s.name || "Section",
            mode: s.bookingMode === "GENERAL_ADMISSION" ? "GENERAL_ADMISSION" : "SEATED",
            price: s.defaultPrice != null ? s.defaultPrice : null,
            currency: s.currency || "JOD",
            capacity: s.capacity != null ? s.capacity : null,
            color: s.color || PALETTE[sections.length % PALETTE.length],
            points: (s.points || []).map(function (p) { return [num(p.x), num(p.y)]; })
        };
    }

    renderAll();
    notify();

    // --- Mode toggle ---------------------------------------------------------
    function setMode(on) {
        editing = on;
        svg.style.pointerEvents = on ? "auto" : "none";
        canvas.classList.toggle("section-editing", on);
        if (btnMode) { btnMode.classList.toggle("active", on); btnMode.textContent = on ? "Done sections" : "Edit sections"; }
        if (tools) { tools.classList.toggle("hidden", !on); }
        if (!on) { cancelDraft(); select(null); }
        renderAll();
    }
    if (btnMode) { btnMode.addEventListener("click", function () { setMode(!editing); }); }

    // --- Create ---------------------------------------------------------------
    function addSection(points, name) {
        var s = {
            key: "sdraft:" + nextDraftKey++, id: null,
            name: name || ("Section " + (sections.length + 1)),
            mode: "SEATED", price: null, currency: "JOD", capacity: null,
            color: PALETTE[sections.length % PALETTE.length],
            points: points
        };
        sections.push(s);
        renderAll();
        select(s);
        markDirty();
        return s;
    }

    if (btnRect) {
        btnRect.addEventListener("click", function () {
            var w = parseInt(canvas.dataset.w, 10) || 900;
            var h = parseInt(canvas.dataset.h, 10) || 600;
            var bw = Math.min(240, w * 0.3), bh = Math.min(160, h * 0.3);
            var x = Math.round(w / 2 - bw / 2), y = Math.round(h / 2 - bh / 2);
            addSection([[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]]);
        });
    }

    // --- Free-draw ------------------------------------------------------------
    if (btnDraw) {
        btnDraw.addEventListener("click", function () {
            if (draft) { cancelDraft(); return; }
            draft = { points: [] };
            setStatus("Click to add points; press Finish (or double-click) to close.");
            if (btnFinish) { btnFinish.classList.remove("hidden"); }
            btnDraw.classList.add("active");
        });
    }
    if (btnFinish) { btnFinish.addEventListener("click", finishDraft); }

    function finishDraft() {
        if (draft && draft.points.length >= 3) {
            addSection(draft.points.slice());
        }
        cancelDraft();
    }
    function cancelDraft() {
        draft = null;
        setStatus("");
        if (btnFinish) { btnFinish.classList.add("hidden"); }
        if (btnDraw) { btnDraw.classList.remove("active"); }
        renderAll();
    }

    svg.addEventListener("pointerdown", function (e) {
        if (!editing) { return; }
        if (draft && e.target === svg) {
            var p = toCanvas(e);
            draft.points.push([Math.round(p.x), Math.round(p.y)]);
            renderAll();
            e.preventDefault();
        } else if (!draft && e.target === svg) {
            select(null);
        }
    });
    svg.addEventListener("dblclick", function () { if (draft) { finishDraft(); } });

    // --- Selection & inspector ------------------------------------------------
    function select(s) {
        selected = s;
        renderAll();
        refreshInspector();
        notify();
    }

    function refreshInspector() {
        if (!inspector) { return; }
        if (!selected) { inspector.classList.add("hidden"); return; }
        inspector.classList.remove("hidden");
        inName.value = selected.name || "";
        inMode.value = selected.mode;
        inPrice.value = selected.price != null ? selected.price : "";
        inCurrency.value = selected.currency || "";
        inCapacity.value = selected.capacity != null ? selected.capacity : "";
        inColor.value = toHex(selected.color);
        if (capField) { capField.classList.toggle("hidden", selected.mode !== "GENERAL_ADMISSION"); }
    }

    bind(inName, "input", function () { selected.name = inName.value; renderAll(); markDirty(); });
    bind(inMode, "change", function () {
        selected.mode = inMode.value === "GENERAL_ADMISSION" ? "GENERAL_ADMISSION" : "SEATED";
        refreshInspector(); renderAll(); markDirty();
    });
    bind(inPrice, "input", function () { selected.price = inPrice.value === "" ? null : parseFloat(inPrice.value); markDirty(); });
    bind(inCurrency, "input", function () { selected.currency = inCurrency.value; markDirty(); });
    bind(inCapacity, "input", function () { selected.capacity = inCapacity.value === "" ? null : parseInt(inCapacity.value, 10); markDirty(); });
    bind(inColor, "input", function () { selected.color = inColor.value; renderAll(); markDirty(); });
    if (btnDel) {
        btnDel.addEventListener("click", function () {
            if (!selected) { return; }
            var i = sections.indexOf(selected);
            if (i !== -1) { sections.splice(i, 1); }
            select(null);
            markDirty();
        });
    }

    // --- Rendering ------------------------------------------------------------
    function renderAll() {
        while (svg.firstChild) { svg.removeChild(svg.firstChild); }
        var w = parseInt(canvas.dataset.w, 10) || 900;
        var h = parseInt(canvas.dataset.h, 10) || 600;
        svg.setAttribute("viewBox", "0 0 " + w + " " + h);
        svg.setAttribute("width", w);
        svg.setAttribute("height", h);

        sections.forEach(function (s) {
            if (s.points.length < 2) { return; }
            var poly = document.createElementNS(SVG_NS, "polygon");
            poly.setAttribute("points", s.points.map(function (p) { return p[0] + "," + p[1]; }).join(" "));
            poly.setAttribute("fill", withAlpha(s.color, s === selected ? 0.34 : 0.18));
            poly.setAttribute("stroke", s.color);
            poly.setAttribute("stroke-width", s === selected ? 2.5 : 1.5);
            poly.style.pointerEvents = editing ? "all" : "none";
            poly.style.cursor = "move";
            poly.addEventListener("pointerdown", function (e) { startMove(e, s); });
            svg.appendChild(poly);

            // Name label at centroid.
            var c = centroid(s.points);
            var label = document.createElementNS(SVG_NS, "text");
            label.setAttribute("x", c[0]); label.setAttribute("y", c[1]);
            label.setAttribute("text-anchor", "middle");
            label.setAttribute("class", "section-label");
            label.textContent = s.name + (s.mode === "GENERAL_ADMISSION" ? " (GA)" : "");
            label.style.pointerEvents = "none";
            svg.appendChild(label);

            if (s === selected && editing) {
                s.points.forEach(function (p, idx) {
                    var dot = document.createElementNS(SVG_NS, "circle");
                    dot.setAttribute("cx", p[0]); dot.setAttribute("cy", p[1]); dot.setAttribute("r", 6);
                    dot.setAttribute("class", "section-handle");
                    dot.style.pointerEvents = "all";
                    dot.style.cursor = "grab";
                    dot.addEventListener("pointerdown", function (e) { startVertex(e, s, idx); });
                    svg.appendChild(dot);
                });
            }
        });

        if (draft && draft.points.length) {
            var pl = document.createElementNS(SVG_NS, "polyline");
            pl.setAttribute("points", draft.points.map(function (p) { return p[0] + "," + p[1]; }).join(" "));
            pl.setAttribute("fill", "none");
            pl.setAttribute("stroke", "#f59e0b");
            pl.setAttribute("stroke-width", 2);
            pl.setAttribute("stroke-dasharray", "6 4");
            svg.appendChild(pl);
        }
    }

    // --- Drag: whole section --------------------------------------------------
    function startMove(e, s) {
        if (!editing || draft) { return; }
        e.preventDefault();
        e.stopPropagation();
        select(s);
        var start = toCanvas(e);
        var orig = s.points.map(function (p) { return [p[0], p[1]]; });
        svg.setPointerCapture(e.pointerId);
        function move(ev) {
            var p = toCanvas(ev);
            var dx = p.x - start.x, dy = p.y - start.y;
            s.points = orig.map(function (o) { return [Math.round(o[0] + dx), Math.round(o[1] + dy)]; });
            renderAll();
        }
        function up() {
            svg.releasePointerCapture(e.pointerId);
            svg.removeEventListener("pointermove", move);
            svg.removeEventListener("pointerup", up);
            markDirty();
        }
        svg.addEventListener("pointermove", move);
        svg.addEventListener("pointerup", up);
    }

    // --- Drag: single vertex --------------------------------------------------
    function startVertex(e, s, idx) {
        if (!editing) { return; }
        e.preventDefault();
        e.stopPropagation();
        svg.setPointerCapture(e.pointerId);
        function move(ev) {
            var p = toCanvas(ev);
            s.points[idx] = [Math.round(p.x), Math.round(p.y)];
            renderAll();
        }
        function up() {
            svg.releasePointerCapture(e.pointerId);
            svg.removeEventListener("pointermove", move);
            svg.removeEventListener("pointerup", up);
            markDirty();
        }
        svg.addEventListener("pointermove", move);
        svg.addEventListener("pointerup", up);
    }

    // --- Public bridge --------------------------------------------------------
    window.HallSectionEditor = {
        // The payload sent to PUT /halls/{id}/seats as `sections`.
        serialize: function () {
            return sections.map(function (s) {
                return {
                    id: s.id,
                    name: s.name,
                    bookingMode: s.mode,
                    defaultPrice: s.price,
                    currency: s.currency || null,
                    capacity: s.mode === "GENERAL_ADMISSION" ? s.capacity : null,
                    shapeKind: "POLYGON",
                    points: s.points.map(function (p) { return { x: p[0], y: p[1] }; }),
                    color: s.color || null
                };
            });
        },
        // Lightweight view for the 2D/3D bridge snapshot.
        getSections: function () {
            return sections.map(function (s) {
                return {
                    key: s.key, id: s.id, name: s.name, mode: s.mode,
                    price: s.price, currency: s.currency, capacity: s.capacity,
                    color: s.color, points: s.points.map(function (p) { return { x: p[0], y: p[1] }; })
                };
            });
        },
        // After a save, refresh ids by matching section name.
        applyServerIds: function (serverSections) {
            var idByName = {};
            (serverSections || []).forEach(function (s) { idByName[s.name] = s.id; });
            sections.forEach(function (s) {
                if (idByName[s.name] != null) { s.id = idByName[s.name]; s.key = "section:" + s.id; }
            });
        }
    };

    // --- helpers --------------------------------------------------------------
    function toCanvas(e) {
        var rect = canvas.getBoundingClientRect();
        var w = parseInt(canvas.dataset.w, 10) || 900;
        var h = parseInt(canvas.dataset.h, 10) || 600;
        return {
            x: (e.clientX - rect.left) * w / Math.max(1, rect.width),
            y: (e.clientY - rect.top) * h / Math.max(1, rect.height)
        };
    }
    function centroid(pts) {
        var x = 0, y = 0;
        pts.forEach(function (p) { x += p[0]; y += p[1]; });
        return [x / pts.length, y / pts.length];
    }
    function withAlpha(hex, a) {
        var c = toHex(hex).replace("#", "");
        if (c.length === 3) { c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]; }
        var r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
        return "rgba(" + r + "," + g + "," + b + "," + a + ")";
    }
    function toHex(color) {
        if (!color) { return "#2E75DC"; }
        return color.charAt(0) === "#" ? color : "#2E75DC";
    }
    function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
    function bind(el, ev, fn) { if (el) { el.addEventListener(ev, function () { if (selected) { fn(); } }); } }
    function setStatus(msg) { if (statusEl) { statusEl.textContent = msg; } }
    function markDirty() {
        var st = document.getElementById("layoutStatus");
        if (st) { st.textContent = "Unsaved changes"; st.className = "layout-status dirty"; }
        notify();
    }
    function notify() {
        window.dispatchEvent(new CustomEvent("hall-sections-change"));
    }
})();
