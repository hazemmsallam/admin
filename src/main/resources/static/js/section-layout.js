/*
 * Section drawing overlay for the hall editor.
 *
 * Sections are first-class, dynamically-named/priced areas. Each is stored as a polygon (points in
 * the same canvas-pixel space as seats), so any shape — rectangle, triangle, or an irregular
 * free-form boundary — is representable without shape-specific code. The admin can:
 *   - edit sections whenever the hall is in the single unified "Edit mode" (this overlay follows
 *     the seat editor's edit state, so both are always live together and grouped seats move too);
 *   - add an adjustable preset (rectangle, circle, triangle or curve), or free-draw a polygon
 *     vertex by vertex — every preset is stored as an ordinary editable polygon;
 *   - drag the whole section, any single vertex, the corner grip to resize the whole shape
 *     symmetrically (uniform scale about its centre, aspect ratio preserved), an edge handle to
 *     stretch just that side along one axis (opposite edge anchored), or the top handle to rotate
 *     it about its centre;
 *   - set name, booking mode (SEATED / GENERAL_ADMISSION), price, currency, capacity and colour;
 *   - multi-select sections (Ctrl/Shift-click to toggle, or drag a marquee box on empty canvas —
 *     the seat editor's marquee runs on the same drag, so one box picks up seats AND sections);
 *   - group a mixed set of sections + seats + tables (Ctrl+G) so dragging any member — a section
 *     here, or a seat in the seat overlay — moves the whole group together; Ctrl+Shift+G ungroups.
 *     Groups are held on window.HallGroups and honoured by seat-layout.js for bidirectional moves.
 *     Alt+click drills into a group to edit/move a single member without ungrouping;
 *   - move the whole selection together by dragging any member — grouping is not required, being
 *     selected together is enough (sections, seats and tables all travel);
 *   - copy/paste the whole selection including its seats and tables (Ctrl+C / Ctrl+V, Ctrl+D to
 *     duplicate). Pasted items are unsaved drafts placed beside the original, persisted by the
 *     normal "Save layout" — there is no separate server round-trip;
 *   - nudge the selection with the arrow keys (Shift = 10px steps);
 *   - delete the selection (button, or Delete/Backspace).
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
    var selected = null;         // primary section: drives the inspector + transform handles
    var selection = [];          // all selected sections (includes `selected`); move together
    var editing = false;         // section-edit mode on/off
    var draft = null;            // in-progress free-draw polygon
    var marquee = null;          // in-progress rubber-band rectangle
    var soloKey = null;          // section key being edited alone inside its group (Alt+click)
    var activeGuides = {};
    var nextDraftKey = 1;
    var clipboard = null;        // copied block: sections + seats + tables, bbox-relative

    // --- DOM controls --------------------------------------------------------
    var tools = document.getElementById("sectionTools");
    var selectionTools = document.getElementById("selectionTools");
    var btnRect = document.getElementById("btnSectionRect");
    var btnCircle = document.getElementById("btnSectionCircle");
    var btnTriangle = document.getElementById("btnSectionTriangle");
    var btnTrapezoid = document.getElementById("btnSectionTrapezoid");
    var btnTrapezoidLeft = document.getElementById("btnSectionTrapezoidLeft");
    var btnTrapezoidRight = document.getElementById("btnSectionTrapezoidRight");
    var btnArena = document.getElementById("btnSectionArena");
    var btnPentagon = document.getElementById("btnSectionPentagon");
    var btnHexagon = document.getElementById("btnSectionHexagon");
    var btnCurve = document.getElementById("btnSectionCurve");
    var btnSidesUp = document.getElementById("btnSidesUp");
    var btnSidesDown = document.getElementById("btnSidesDown");
    var sidesCount = document.getElementById("sidesCount");
    var btnStar = document.getElementById("btnSectionStar");
    var btnDraw = document.getElementById("btnSectionDraw");
    var btnFinish = document.getElementById("btnSectionFinish");
    var btnCopy = document.getElementById("btnCopySelection");
    var btnPaste = document.getElementById("btnPasteSelection");
    var btnDuplicate = document.getElementById("btnDuplicateSelection");
    var btnGroup = document.getElementById("btnGroupSelection");
    var btnUngroup = document.getElementById("btnUngroupSelection");
    var btnSelectAll = document.getElementById("btnSelectLayout");
    var rotationButtons = document.querySelectorAll("[data-section-rotation]");
    var mirrorButtons = document.querySelectorAll("[data-section-mirror]");
    var btnDel = document.getElementById("btnSectionDelete");
    var inspector = document.getElementById("sectionInspector");
    var inName = document.getElementById("sxName");
    var inMode = document.getElementById("sxMode");
    var inCurrency = document.getElementById("sxCurrency");
    var inFee = document.getElementById("sxServiceFee");
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
            currency: s.currency || "JOD",
            capacity: s.capacity != null ? s.capacity : null,
            serviceFeePerTicket: s.serviceFeePerTicket,
            color: s.color || PALETTE[sections.length % PALETTE.length],
            shapeKind: s.shapeKind || "POLYGON",
            points: (s.points || []).map(function (p) { return [num(p.x), num(p.y)]; })
        };
    }

    // Points for a shape preset inscribed in the box (x,y,w,h), mirroring the backend ShapePoints
    // generator so a circle/triangle/curve section is stored as an ordinary editable polygon.
    var CIRCLE_SEGMENTS = 48, CURVE_SEGMENTS = 32;
    // Straight-sided editing limits: below 3 it stops being a polygon, and past ~16 sides the
    // per-edge handles become an unusable ring of confetti (a circle carries 48 points).
    var MIN_SIDES = 3, MAX_SIDES = 12, EDGE_HANDLE_LIMIT = 16;
    function shapePoints(kind, x, y, w, h) {
        var cx = x + w / 2, cy = y + h / 2, pts = [], i, ang;
        if (kind === "TRIANGLE") {
            return [[cx, y], [x + w, y + h], [x, y + h]];
        }
        if (kind === "TRAPEZOID") {
            // Isoceles trapezoid — narrow top (stage side), wide bottom (back of hall).
            var inset = w * 0.2;
            return [[x + inset, y], [x + w - inset, y], [x + w, y + h], [x, y + h]];
        }
        if (kind === "TRAPEZOID_LEFT") {
            // Arena left-wing — right edge vertical (meets centre block), left side slants outward going down.
            var topL = w * 0.3;
            return [[x + topL, y], [x + w, y], [x + w, y + h], [x, y + h]];
        }
        if (kind === "TRAPEZOID_RIGHT") {
            // Arena right-wing — left edge vertical (meets centre block), right side slants outward going down.
            var topR = w * 0.3;
            return [[x, y], [x + w - topR, y], [x + w, y + h], [x, y + h]];
        }
        if (kind === "CIRCLE" || kind === "ELLIPSE") {
            var rx = w / 2, ry = h / 2;
            for (i = 0; i < CIRCLE_SEGMENTS; i++) {
                ang = 2 * Math.PI * i / CIRCLE_SEGMENTS;
                pts.push([cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]);
            }
            return round(pts);
        }
        if (kind === "CURVE") {
            var outer = w / 2, inner = outer / 2, yScale = h / outer;
            for (i = 0; i <= CURVE_SEGMENTS; i++) {
                ang = Math.PI - Math.PI * i / CURVE_SEGMENTS;
                pts.push([cx + outer * Math.cos(ang), y + h - outer * Math.sin(ang) * yScale]);
            }
            for (i = 0; i <= CURVE_SEGMENTS; i++) {
                ang = Math.PI * i / CURVE_SEGMENTS;
                pts.push([cx + inner * Math.cos(ang), y + h - inner * Math.sin(ang) * yScale]);
            }
            return round(pts);
        }
        if (kind === "PENTAGON") { return regularPolygon(cx, cy, w / 2, h / 2, 5); }
        if (kind === "HEXAGON") { return regularPolygon(cx, cy, w / 2, h / 2, 6); }
        // RECTANGLE / default
        return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    }
    function round(pts) { return pts.map(function (p) { return [Math.round(p[0]), Math.round(p[1])]; }); }

    /**
     * A regular n-gon inscribed in the box, first vertex pointing straight up so a pentagon or
     * hexagon reads the way people draw one. Mirrors ShapePoints.regularPolygon on the server.
     */
    function regularPolygon(cx, cy, rx, ry, sides) {
        if (sides < 3) { return []; }
        var pts = [];
        for (var i = 0; i < sides; i++) {
            var ang = -Math.PI / 2 + 2 * Math.PI * i / sides;
            pts.push([cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]);
        }
        return round(pts);
    }

    // --- Edge operations ------------------------------------------------------
    // Edge i runs from point i to point i+1 (wrapping). Both operations keep the boundary a
    // single closed ring, so nothing downstream changes: containment is ray-cast, which handles
    // concave rings, and the mobile client replays the same points.

    /**
     * Removes edge i by collapsing its two endpoints into their midpoint — a regular hexagon
     * becomes a symmetric pentagon. Refuses below 4 points, since a triangle has no edge to
     * spare without ceasing to be a polygon.
     */
    function removeEdge(s, i) {
        var n = s.points.length;
        if (n < 4) {
            setStatus("A shape needs at least three sides.");
            return false;
        }
        var a = s.points[i], b = s.points[(i + 1) % n];
        var mid = [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2)];
        var next = [];
        for (var k = 0; k < n; k++) {
            if (k === i) { next.push(mid); }          // the merged point replaces both ends
            else if (k !== (i + 1) % n) { next.push(s.points[k]); }
        }
        return applySectionPoints(s, next);
    }

    /**
     * Folds edge i inward: inserts a vertex pulled toward the shape's centre, turning that side
     * into a V-notch. Applied to every edge of an n-gon this yields an n-pointed star — the
     * "spider web" shape — and each new vertex stays draggable afterwards.
     */
    function invertEdge(s, i, depth) {
        var n = s.points.length;
        var c = centroid(s.points);
        var a = s.points[i], b = s.points[(i + 1) % n];
        var mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        var f = depth == null ? 0.55 : depth;         // 0 = at the centre, 1 = unchanged
        var inner = [
            Math.round(c[0] + (mid[0] - c[0]) * f),
            Math.round(c[1] + (mid[1] - c[1]) * f)
        ];
        var points = s.points.slice();
        points.splice(i + 1, 0, inner);
        return applySectionPoints(s, points);
    }

    /** Folds every edge inward at once — the one-click star / spider web. */
    function invertAllEdges(s) {
        var c = centroid(s.points);
        var n = s.points.length;
        var next = [];
        for (var i = 0; i < n; i++) {
            var a = s.points[i], b = s.points[(i + 1) % n];
            var mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            next.push(a);
            next.push([
                Math.round(c[0] + (mid[0] - c[0]) * 0.55),
                Math.round(c[1] + (mid[1] - c[1]) * 0.55)
            ]);
        }
        return applySectionPoints(s, next);
    }

    /**
     * Rebuilds the selected section as a regular n-gon filling its current bounding box, so the
     * sides stepper walks pentagon → hexagon → heptagon without moving or resizing the section.
     */
    function setSides(s, sides) {
        var b = bbox(s.points);
        var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
        var rx = Math.max(12, (b.maxX - b.minX) / 2), ry = Math.max(12, (b.maxY - b.minY) / 2);
        if (!applySectionPoints(s, regularPolygon(cx, cy, rx, ry, sides))) { return false; }
        s.shapeKind = sides === 5 ? "PENTAGON" : sides === 6 ? "HEXAGON" : "POLYGON";
        return true;
    }

    // Adds a preset-shaped section centred on the canvas.
    function addPreset(kind) {
        var w = parseInt(canvas.dataset.w, 10) || 900;
        var h = parseInt(canvas.dataset.h, 10) || 600;
        var bw = Math.min(240, w * 0.3), bh = Math.min(160, h * 0.3);
        // Regular shapes need a square box, or the n-gon comes out stretched into an ellipse.
        if (kind === "CIRCLE" || kind === "PENTAGON" || kind === "HEXAGON") {
            bh = bw = Math.min(bw, bh);
        }
        var x = Math.round(w / 2 - bw / 2), y = Math.round(h / 2 - bh / 2);
        var points = shapePoints(kind, x, y, bw, bh);
        addSection(placeNewSections([points])[0], null, kind);
    }

    /**
     * Drops a three-piece arena bowl in one click: a centre block flanked by two mirrored wings
     * cut from the same big trapezoid. The three pieces share seams exactly along the big
     * trapezoid's two slanted spokes, so from the audience the whole bowl reads as one
     * continuous fan — narrow near the stage, wide at the back.
     *
     * Layout: full bowl is 70% of canvas width × 40% of canvas height, with the top edge about
     * 55% of the bottom edge. The centre takes the middle 40% of the width at every row, so
     * each wing is 30% of the width at the bottom, splaying inward as it climbs toward the stage.
     */
    function addArena() {
        var w = parseInt(canvas.dataset.w, 10) || 900;
        var hh = parseInt(canvas.dataset.h, 10) || 600;
        var arenaW = Math.min(820, w * 0.8);
        var arenaH = Math.min(300, hh * 0.42);
        var cx = Math.round(w / 2);
        var y = Math.round((hh - arenaH) / 2);
        var yB = y + arenaH;
        var botHalf = arenaW / 2;
        var topHalf = botHalf * 0.55;       // top is 55% of bottom width — matches the Figma arena
        var ctFrac = 0.42;                  // centre takes 42% of the width at every row

        var ctTopL = Math.round(cx - topHalf * ctFrac);
        var ctTopR = Math.round(cx + topHalf * ctFrac);
        var ctBotL = Math.round(cx - botHalf * ctFrac);
        var ctBotR = Math.round(cx + botHalf * ctFrac);
        var leftTopX = Math.round(cx - topHalf);
        var leftBotX = Math.round(cx - botHalf);
        var rightTopX = Math.round(cx + topHalf);
        var rightBotX = Math.round(cx + botHalf);

        var centre = [[ctTopL, y], [ctTopR, y], [ctBotR, yB], [ctBotL, yB]];
        var left   = [[leftTopX, y], [ctTopL, y], [ctBotL, yB], [leftBotX, yB]];
        var right  = [[ctTopR, y], [rightTopX, y], [rightBotX, yB], [ctBotR, yB]];
        var placed = placeNewSections([left, centre, right]);
        addSection(placed[0], "Left Wing", "TRAPEZOID_LEFT");
        addSection(placed[1], "Centre", "TRAPEZOID");
        addSection(placed[2], "Right Wing", "TRAPEZOID_RIGHT");
    }

    ensureSectionsFit(sections);
    renderAll();
    notify();

    // --- Tabbed toolbar ------------------------------------------------------
    // Tabs compose with the existing `hidden` toggles via a separate `tab-hidden` class, so we
    // never fight the seat/section modules' own show/hide logic: a panel is visible only when it
    // is neither `hidden` (edit off / nothing selected) nor `tab-hidden` (not the active tab).
    var Tabs = (function () {
        var bar = document.getElementById("editTabs");
        var buttons = bar ? Array.prototype.slice.call(bar.querySelectorAll(".edit-tab")) : [];
        var panels = Array.prototype.slice.call(document.querySelectorAll("[data-tab]"))
            .filter(function (el) { return !el.classList.contains("edit-tab"); });
        var api = {
            active: "1",
            onEditModeChange: function (on) {
                if (bar) { bar.classList.toggle("hidden", !on); }
                if (on) { api.activate(api.active); }
                else { panels.forEach(function (p) { p.classList.remove("tab-hidden"); }); }
            },
            activate: function (tab) {
                api.active = String(tab);
                buttons.forEach(function (b) {
                    var on = b.getAttribute("data-tab") === api.active;
                    b.classList.toggle("active", on);
                    b.setAttribute("aria-selected", on ? "true" : "false");
                });
                panels.forEach(function (p) {
                    p.classList.toggle("tab-hidden", p.getAttribute("data-tab") !== api.active);
                });
            }
        };
        buttons.forEach(function (b) {
            b.addEventListener("click", function () { api.activate(b.getAttribute("data-tab")); });
        });
        return api;
    })();

    // --- Unified edit mode ---------------------------------------------------
    // Section editing is no longer a separate toggle: it follows the single "Edit mode" button in
    // the seat editor, so both overlays are live together. That is also what makes grouped seats
    // move during a section drag (the seat patch API is a no-op unless the seat editor is editing).
    function setMode(on) {
        if (editing === on) { return; }
        editing = on;
        // NB: the SVG layer itself stays pointer-events:none (see app.css) so seats/tables below it
        // remain clickable; only the polygons and handles opt back in while editing.
        canvas.classList.toggle("section-editing", on);
        if (tools) { tools.classList.toggle("hidden", !on); }
        if (selectionTools) { selectionTools.classList.toggle("hidden", !on); }
        if (!on) { cancelDraft(); select(null); }
        Tabs.onEditModeChange(on);
        if (on) { Presets.refresh(); }   // fetch the saved-preset list on first entry to edit mode
        refreshCommandState();
        renderOutliner();
        renderAll();
    }

    var syncingSeats = false;   // true while WE push a selection into the seat editor (avoid loops)
    function bindSeatMode() {
        window.HallSeatEditor.subscribe(function (state, reason) {
            if (reason === "mode" || reason === "subscribe" || reason === "ready") {
                setMode(!!state.editing);
            }
            if (editing && reason === "change" && syncSeatSections()) {
                notify();
            }
            if (reason === "change" || reason === "mode") {
                window.HallSeatEditor.validateSeatPlacements();
            }
            if (!editing || syncingSeats) { return; }
            // Follow the user's focus: seats -> tab 1, tables -> tab 3.
            if (reason === "selection" && state.selectedKeys && state.selectedKeys.length) {
                Tabs.activate("1");
            } else if (reason === "tableSelection"
                    && (state.tables || []).some(function (t) { return t.selected; })) {
                Tabs.activate("3");
            }
            if (reason === "selection" || reason === "tableSelection" ||
                    reason === "change" || reason === "mode") {
                refreshCommandState();
            }
        });
    }

    // --- Create ---------------------------------------------------------------
    function addSection(points, name, shapeKind) {
        var s = {
            key: "sdraft:" + nextDraftKey++, id: null,
            name: name || ("Section " + (sections.length + 1)),
            mode: "SEATED", currency: "JOD", capacity: null,
            color: PALETTE[sections.length % PALETTE.length],
            shapeKind: shapeKind || "POLYGON",
            points: points
        };
        if (!applySectionPoints(s, points)) { return null; }
        sections.push(s);
        renderAll();
        select(s);
        markDirty();
        return s;
    }

    if (btnRect) { btnRect.addEventListener("click", function () { addPreset("RECTANGLE"); }); }
    if (btnCircle) { btnCircle.addEventListener("click", function () { addPreset("CIRCLE"); }); }
    if (btnTriangle) { btnTriangle.addEventListener("click", function () { addPreset("TRIANGLE"); }); }
    if (btnTrapezoid) { btnTrapezoid.addEventListener("click", function () { addPreset("TRAPEZOID"); }); }
    if (btnTrapezoidLeft) { btnTrapezoidLeft.addEventListener("click", function () { addPreset("TRAPEZOID_LEFT"); }); }
    if (btnTrapezoidRight) { btnTrapezoidRight.addEventListener("click", function () { addPreset("TRAPEZOID_RIGHT"); }); }
    if (btnArena) { btnArena.addEventListener("click", function () { addArena(); }); }
    if (btnPentagon) { btnPentagon.addEventListener("click", function () { addPreset("PENTAGON"); }); }
    if (btnHexagon) { btnHexagon.addEventListener("click", function () { addPreset("HEXAGON"); }); }
    if (btnCurve) { btnCurve.addEventListener("click", function () { addPreset("CURVE"); }); }

    // --- Sides stepper & star -------------------------------------------------
    // The stepper regenerates a regular n-gon in the section's existing box, which is the only
    // way to go hexagon -> pentagon and stay *regular*: removing an edge leaves the surviving
    // vertices on their original angles, so the result is a valid but irregular pentagon.
    function stepSides(delta) {
        var s = singleSelection();
        if (!s) { return; }
        var n = s.points.length;
        if (n > MAX_SIDES) {
            setStatus("That shape has too many points to step — use a preset first.");
            return;
        }
        var target = Math.min(MAX_SIDES, Math.max(MIN_SIDES, n + delta));
        if (target === n) { return; }
        if (!setSides(s, target)) { return; }
        renderAll();
        refreshShapeTools();
        markDirty();
        setStatus("Now a regular " + target + "-sided shape.");
    }

    /** The one selected section, or null when the tools don't apply. */
    function singleSelection() {
        if (selection.length !== 1) {
            setStatus("Select a single section first.");
            return null;
        }
        return selection[0];
    }

    /** Keeps the sides readout and button states honest about what's selected. */
    function refreshShapeTools() {
        if (!sidesCount) { return; }
        var s = selection.length === 1 ? selection[0] : null;
        var n = s ? s.points.length : 0;
        sidesCount.textContent = s ? String(n) : "—";
        var steppable = !!s && n <= MAX_SIDES;
        if (btnSidesUp) { btnSidesUp.disabled = !steppable || n >= MAX_SIDES; }
        if (btnSidesDown) { btnSidesDown.disabled = !steppable || n <= MIN_SIDES; }
        if (btnStar) { btnStar.disabled = !s || n > EDGE_HANDLE_LIMIT; }
    }

    if (btnSidesUp) { btnSidesUp.addEventListener("click", function () { stepSides(1); }); }
    if (btnSidesDown) { btnSidesDown.addEventListener("click", function () { stepSides(-1); }); }
    if (btnStar) {
        btnStar.addEventListener("click", function () {
            var s = singleSelection();
            if (!s) { return; }
            if (s.points.length > EDGE_HANDLE_LIMIT) {
                setStatus("Too many sides to fold — try a pentagon or hexagon.");
                return;
            }
            if (!invertAllEdges(s)) { return; }
            s.shapeKind = "POLYGON";
            renderAll();
            refreshShapeTools();
            markDirty();
            setStatus("Folded every side inward — " + (s.points.length / 2) + "-pointed star.");
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

    // Empty-canvas gestures listen on the canvas (not the SVG, which is pointer-events:none so
    // seats stay clickable). We deliberately do NOT stop propagation: the seat editor's own marquee
    // runs on the same drag, so one box selects the seats AND sections inside it — which is exactly
    // what Ctrl+G then needs to group them together.
    canvas.addEventListener("pointerdown", function (e) {
        if (!editing || e.target !== canvas || e.button !== 0) { return; }
        if (draft) {
            var p = toCanvas(e);
            draft.points.push([Math.round(p.x), Math.round(p.y)]);
            renderAll();
            e.preventDefault();
        } else {
            startMarquee(e);
        }
    });
    canvas.addEventListener("dblclick", function () { if (draft) { finishDraft(); } });

    // --- Marquee (rubber-band) select -----------------------------------------
    function startMarquee(e) {
        if (draft) { return; }
        var start = toCanvas(e);
        var additive = e.ctrlKey || e.metaKey || e.shiftKey;
        var base = additive ? selection.slice() : [];
        marquee = { box: { minX: start.x, minY: start.y, maxX: start.x, maxY: start.y }, moved: false };
        renderAll();
        function move(ev) {
            var p = toCanvas(ev);
            if (Math.abs(p.x - start.x) > 3 || Math.abs(p.y - start.y) > 3) { marquee.moved = true; }
            var box = { minX: Math.min(start.x, p.x), minY: Math.min(start.y, p.y),
                        maxX: Math.max(start.x, p.x), maxY: Math.max(start.y, p.y) };
            marquee.box = box;
            var set = base.slice();
            sections.forEach(function (s) {
                if (s.points.length >= 2 && rectsIntersect(box, bbox(s.points))) { addWithGroup(set, s); }
            });
            selection = set;
            selected = set.length ? set[set.length - 1] : null;
            renderAll();
        }
        function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            var moved = marquee.moved;
            marquee = null;
            // A box drag co-selects seats (seat editor) — keep those, so treat it as additive.
            if (!moved && !additive) { setSelection([]); }
            else { setSelection(selection, { additive: true }); }
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // Adds a section and every co-member of its group to `set` (no duplicates).
    function addWithGroup(set, s) {
        var g = Groups.groupOf("section", s.key);
        var members = g ? sectionsInGroup(g) : [s];
        members.forEach(function (m) { if (set.indexOf(m) === -1) { set.push(m); } });
    }

    function rectsIntersect(a, b) {
        return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
    }

    // --- Selection & inspector ------------------------------------------------
    // Selecting a section that belongs to a group selects the whole group (and its seats/tables).
    function select(s, opts) {
        if (!s) { setSelection([], opts); return; }
        var g = Groups.groupOf("section", s.key);
        if (g) { selectGroup(g, s, opts); return; }
        setSelection([s], opts);
    }

    // Selects exactly one section, ignoring its group — this is how a single member of a group is
    // edited without breaking the group apart (Alt+click).
    function selectSolo(s) {
        soloKey = s ? s.key : null;
        setSelection(s ? [s] : []);
    }

    function setSelection(list, opts) {
        var additive = !!(opts && opts.additive);
        selection = list.slice();
        selected = selection.length ? selection[selection.length - 1] : null;
        if (!additive) { soloKey = selection.length === 1 ? soloKey : null; }
        syncSeatSelection(additive);
        afterSelectionChange();
    }

    // Shared tail for every selection change: refresh views and, when sections are selected, bring
    // the "Section functions" tab and outliner highlight in sync.
    function afterSelectionChange() {
        if (selection.length && editing) { Tabs.activate("2"); }
        renderAll();
        refreshInspector();
        renderOutliner();
        refreshCommandState();
        refreshShapeTools();
        notify();
    }

    function isSel(s) { return selection.indexOf(s) !== -1; }

    // Ctrl/Shift-click: add or remove a single section from the multi-selection.
    function toggleSel(s) {
        var g = Groups.groupOf("section", s.key);
        var targets = g ? sectionsInGroup(g) : [s];
        var allIn = targets.every(isSel);
        targets.forEach(function (t) {
            var i = selection.indexOf(t);
            if (allIn) { if (i !== -1) { selection.splice(i, 1); } }
            else if (i === -1) { selection.push(t); }
        });
        selected = selection.length ? selection[selection.length - 1] : null;
        soloKey = null;
        // additive: a Ctrl/Shift-click must never wipe the seats the user already picked, because
        // that mixed seats + sections selection is exactly what Ctrl+G groups.
        syncSeatSelection(true);
        afterSelectionChange();
    }

    function selectGroup(g, primary, opts) {
        var list = sectionsInGroup(g);
        selection = list.slice();
        selected = primary && isSel(primary) ? primary : (list[0] || null);
        soloKey = null;
        syncSeatSelection(!!(opts && opts.additive));
        afterSelectionChange();
    }

    function sectionsInGroup(g) {
        return sections.filter(function (s) { return g.members.sections.indexOf(s.key) !== -1; });
    }

    // Mirror the section selection's grouped seats/tables into the seat editor so a group
    // highlights consistently across both overlays.
    // Mirrors the section selection into the seat editor. A plain (non-additive) section click is
    // exclusive: it clears any seat selection, so the inspector and tabs always describe one thing.
    // Ctrl/Shift-click and marquee drags pass additive=true, which preserves the seat selection so
    // seats and sections can be co-selected and then grouped with Ctrl+G.
    function syncSeatSelection(additive) {
        if (!window.HallSeatEditor) { return; }
        var seatKeys = {};
        selection.forEach(function (s) {
            if (soloKey && s.key !== soloKey) { return; }
            var g = Groups.groupOf("section", s.key);
            if (g) { g.members.seats.forEach(function (k) { seatKeys[k] = 1; }); }
        });
        var keys = Object.keys(seatKeys);
        if (!keys.length && additive) { return; }   // keep whatever the user already had selected
        syncingSeats = true;
        try { window.HallSeatEditor.select(keys); } catch (e) { /* ignore */ }
        syncingSeats = false;
    }

    // --- Group registry (session-scoped) --------------------------------------
    // A group binds a set of sections + seats + tables so they move as one unit. Membership is by
    // stable editor key; the registry is shared on window.HallGroups so the seat module can honour
    // it when a grouped seat is dragged (bidirectional move).
    var groupList = [];
    var nextGroupId = 1;
    var Groups = {
        groupOf: function (kind, key) {
            var arr = kind === "section" ? "sections" : kind === "seat" ? "seats" : "tables";
            for (var i = 0; i < groupList.length; i++) {
                if (groupList[i].members[arr].indexOf(key) !== -1) { return groupList[i]; }
            }
            return null;
        },
        all: function () { return groupList; },
        remove: function (g) { var i = groupList.indexOf(g); if (i !== -1) { groupList.splice(i, 1); } },
        rekey: function (kind, oldKey, newKey) {
            var arr = kind === "section" ? "sections" : kind === "seat" ? "seats" : "tables";
            groupList.forEach(function (g) {
                var i = g.members[arr].indexOf(oldKey);
                if (i !== -1) { g.members[arr][i] = newKey; }
            });
        },
        // For the seat module: the section/table members grouped with a dragged seat/table, with
        // their current positions captured so it can drive `applyMemberBaseline` without drift.
        memberBaseline: function (kind, key) {
            var g = this.groupOf(kind, key);
            var out = { sections: [], tables: [], seats: [] };
            // Companions = this item's group members PLUS anything co-selected here. Selecting a
            // set and dragging one of them moves the whole set, group or not.
            var wantSections = {}, wantTables = {};
            if (g) {
                g.members.sections.forEach(function (k) { wantSections[k] = 1; });
                g.members.tables.forEach(function (k) { wantTables[k] = 1; });
            }
            selection.forEach(function (s) { wantSections[s.key] = 1; });
            sections.forEach(function (s) {
                if (wantSections[s.key]) {
                    out.sections.push({ key: s.key, pts: s.points.map(function (p) { return [p[0], p[1]]; }) });
                }
            });
            if (window.HallSeatEditor) {
                var st; try { st = window.HallSeatEditor.getState(); } catch (e) { st = null; }
                if (st) {
                    (st.tables || []).forEach(function (t) {
                        if (wantTables[t.key] || t.selected) { out.tables.push({ key: t.key, x: t.x, y: t.y }); }
                    });
                    if (g) {
                        (st.seats || []).forEach(function (q) {
                            if (g.members.seats.indexOf(q.key) !== -1) { out.seats.push({ key: q.key, x: q.x, y: q.y }); }
                        });
                    }
                }
            }
            return out;
        },
        // Applies a baseline (from memberBaseline) at delta (dx,dy). Moves this module's sections and
        // — via the seat editor — the grouped tables. Seats are left to the seat module's own drag.
        applyMemberBaseline: function (base, dx, dy, transient) {
            if (!base) { return; }
            var moving = base.sections.map(function (item) {
                return { section: sectionByKey(item.key), points: item.pts.map(function (p) {
                    return [Math.round(p[0] + dx), Math.round(p[1] + dy)];
                }) };
            }).filter(function (item) { return item.section; });
            var moved = new Set(moving.map(function (item) { return item.section; }));
            if (sectionsOverlap(moving, sections.filter(function (section) { return !moved.has(section); }))) {
                setStatus("Sections cannot overlap.");
                return;
            }
            moving.forEach(function (item) { item.section.points = item.points; });
            if (base.tables.length && window.HallSeatEditor && window.HallSeatEditor.applyTablePatch) {
                window.HallSeatEditor.applyTablePatch(
                    base.tables.map(function (b) { return { key: b.key, x: b.x + dx, y: b.y + dy }; }),
                    { transient: transient });
            }
            renderAll();
            if (!transient) { markDirty(); }
        }
    };

    function sectionByKey(key) {
        for (var i = 0; i < sections.length; i++) { if (sections[i].key === key) { return sections[i]; } }
        return null;
    }

    // Current seat/table selection from the seat editor.
    function seatSelection() {
        var out = { seats: [], tables: [] };
        if (!window.HallSeatEditor) { return out; }
        var st; try { st = window.HallSeatEditor.getState(); } catch (e) { return out; }
        out.seats = (st.selectedKeys || []).slice();
        (st.tables || []).forEach(function (t) { if (t.selected) { out.tables.push(t.key); } });
        return out;
    }

    function refreshCommandState() {
        var mixed = seatSelection();
        var sectionKeys = selection.map(function (s) { return s.key; });
        var total = sectionKeys.length + mixed.seats.length + mixed.tables.length;
        var touchesGroup = groupList.some(function (g) {
            return sectionKeys.some(function (k) { return g.members.sections.indexOf(k) !== -1; }) ||
                mixed.seats.some(function (k) { return g.members.seats.indexOf(k) !== -1; }) ||
                mixed.tables.some(function (k) { return g.members.tables.indexOf(k) !== -1; });
        });
        [...rotationButtons, ...mirrorButtons].forEach(function (button) {
            button.disabled = selection.length !== 1 || !editing || !!draft;
        });
        if (btnCopy) { btnCopy.disabled = total === 0; }
        if (btnDuplicate) { btnDuplicate.disabled = total === 0; }
        if (btnPaste) { btnPaste.disabled = !clipboard; }
        if (btnGroup) { btnGroup.disabled = total < 2; }
        if (btnUngroup) { btnUngroup.disabled = !touchesGroup; }
        var savePreset = document.getElementById("btnSavePreset");
        if (savePreset) { savePreset.disabled = total === 0; }
    }

    function groupSelection() {
        var seatSel = seatSelection();
        var sectionKeys = selection.map(function (s) { return s.key; });
        var total = sectionKeys.length + seatSel.seats.length + seatSel.tables.length;
        if (total < 2) {
            setStatus("Select at least two items (sections and/or seats) to group.");
            return;
        }
        // Detach these members from any existing group so groups never overlap.
        var claim = { sections: sectionKeys, seats: seatSel.seats, tables: seatSel.tables };
        ["sections", "seats", "tables"].forEach(function (arr) {
            claim[arr].forEach(function (key) {
                groupList.forEach(function (g) {
                    var i = g.members[arr].indexOf(key);
                    if (i !== -1) { g.members[arr].splice(i, 1); }
                });
            });
        });
        groupList = groupList.filter(function (g) {
            return g.members.sections.length + g.members.seats.length + g.members.tables.length > 1;
        });
        var g = {
            id: "g" + (nextGroupId++),
            name: "Group " + nextGroupId,
            members: { sections: sectionKeys.slice(), seats: seatSel.seats.slice(), tables: seatSel.tables.slice() }
        };
        groupList.push(g);
        setStatus("Grouped " + total + " items as “" + g.name + "”.");
        renderAll();
        renderOutliner();
        refreshCommandState();
        markDirty();
        notify();
    }

    function ungroupSelection() {
        var removed = 0;
        var seatSel = seatSelection();
        var keys = { sections: selection.map(function (s) { return s.key; }), seats: seatSel.seats, tables: seatSel.tables };
        groupList = groupList.filter(function (g) {
            var hit = ["sections", "seats", "tables"].some(function (arr) {
                return keys[arr].some(function (k) { return g.members[arr].indexOf(k) !== -1; });
            });
            if (hit) { removed++; }
            return !hit;
        });
        if (removed) {
            setStatus("Ungrouped " + removed + " group(s).");
            renderAll();
            renderOutliner();
            refreshCommandState();
            markDirty();
            notify();
        }
    }

    window.HallGroups = Groups;

    // --- Select all -----------------------------------------------------------
    // Selects every section and seat. Objects remain single-select in the current editor model.
    function selectAll() {
        if (window.HallSeatEditor) {
            var st; try { st = window.HallSeatEditor.getState(); } catch (e) { st = null; }
            if (st) {
                syncingSeats = true;
                try { window.HallSeatEditor.select((st.seats || []).map(function (q) { return q.key; })); }
                catch (e) { /* ignore */ }
                syncingSeats = false;
            }
        }
        setSelection(sections.slice(), { additive: true });
        setStatus("Selected everything: " + sections.length + " section(s) and all seats.");
    }

    // --- Saved presets --------------------------------------------------------
    // A preset is a captured selection, named and persisted through the admin app
    // (/layout-presets -> the ticketing API). Names are unique; the API answers 409 on a clash.
    var Presets = (function () {
        var picker = document.getElementById("presetPicker");
        var btnSave = document.getElementById("btnSavePreset");
        var btnApply = document.getElementById("btnApplyPreset");
        var btnDelete = document.getElementById("btnDeletePreset");
        var loaded = false;

        function refreshPickerActions() {
            var hasPreset = !!(picker && picker.value);
            if (btnApply) { btnApply.disabled = !hasPreset; }
            if (btnDelete) { btnDelete.disabled = !hasPreset; }
        }
        if (picker) { picker.addEventListener("change", refreshPickerActions); }
        refreshPickerActions();

        function headers() {
            var h = { "Content-Type": "application/json" };
            var token = document.querySelector('meta[name="_csrf"]');
            var header = document.querySelector('meta[name="_csrf_header"]');
            if (token && header && header.content) { h[header.content] = token.content; }
            return h;
        }

        function refresh() {
            if (!picker) { return; }
            fetch("/layout-presets", { headers: { "Accept": "application/json" } })
                .then(function (r) { return r.ok ? r.json() : []; })
                .then(function (list) {
                    var keep = picker.value;
                    picker.textContent = "";
                    var first = document.createElement("option");
                    first.value = "";
                    first.textContent = list.length ? "Saved presets…" : "No saved presets";
                    picker.appendChild(first);
                    list.forEach(function (p) {
                        var o = document.createElement("option");
                        o.value = p.id;
                        var bits = [];
                        if (p.sectionCount) { bits.push(p.sectionCount + " sec"); }
                        if (p.seatCount) { bits.push(p.seatCount + " seats"); }
                        if (p.tableCount) { bits.push(p.tableCount + " objects"); }
                        o.textContent = p.name + (bits.length ? "  (" + bits.join(", ") + ")" : "");
                        picker.appendChild(o);
                    });
                    picker.value = keep;
                    loaded = true;
                    refreshPickerActions();
                })
                .catch(function () { /* the picker just stays empty */ });
        }

        function save() {
            var block = captureSelection();
            if (!block) {
                setStatus("Select something first, then save it as a preset.");
                return;
            }
            var name = window.prompt("Name this preset (must be unique):", "");
            if (name === null) { return; }
            name = name.trim();
            if (!name) { setStatus("A preset needs a name."); return; }

            setStatus("Saving preset…");
            fetch("/layout-presets", {
                method: "POST",
                headers: headers(),
                body: JSON.stringify(toPayload(name, block))
            }).then(function (r) {
                if (r.ok) {
                    setStatus("Saved preset “" + name + "”.");
                    refresh();
                    return;
                }
                return r.text().then(function (msg) {
                    // 409 = the name is taken; the API's message already says so.
                    setStatus(msg || (r.status === 409
                        ? "A preset with that name already exists."
                        : "Could not save the preset."));
                });
            }).catch(function () { setStatus("Could not reach the server to save the preset."); });
        }

        // Editor block -> API payload (see CreateLayoutPresetRequest).
        function toPayload(name, block) {
            return {
                name: name,
                description: describe(block),
                width: Math.max(1, Math.round(block.width)),
                height: Math.max(1, Math.round(block.height)),
                members: {
                    sections: block.sections.map(function (s) {
                        return {
                            name: s.name,
                            bookingMode: s.mode,
                            currency: s.currency,
                            capacity: s.capacity,
                            serviceFeePerTicket: s.serviceFeePerTicket,
                            shapeKind: s.shapeKind || "POLYGON",
                            points: s.points.map(function (p) { return { x: p[0], y: p[1] }; }),
                            color: s.color
                        };
                    }),
                    seats: block.seats.map(function (q) {
                        return {
                            x: Math.round(q.x), y: Math.round(q.y),
                            width: q.w, height: q.h,
                            rotationDegrees: q.rot || 0,
                            sectionName: q.section || null,
                            rowOffset: q.r != null ? q.r : null,
                            sectionIndex: q.sectionIndex
                        };
                    }),
                    tables: block.tables.map(function (t) {
                        return {
                            objectType: t.objectType || "TABLE",
                            shape: t.shape, label: t.label || null,
                            x: Math.round(t.x), y: Math.round(t.y), z: t.z || 0,
                            rotationDegrees: t.rot || 0,
                            width: t.w, depth: t.d, objectHeight: t.height
                        };
                    })
                }
            };
        }

        // API payload -> editor block (the inverse of toPayload).
        function toBlock(preset) {
            var m = preset.members || {};
            return {
                width: preset.width, height: preset.height, originX: 0, originY: 0,
                sections: (m.sections || []).map(function (s) {
                    return {
                        name: s.name, mode: s.bookingMode,
                        currency: s.currency, capacity: s.capacity, serviceFeePerTicket: s.serviceFeePerTicket, color: s.color,
                        shapeKind: s.shapeKind,
                        points: (s.points || []).map(function (p) { return [p.x, p.y]; })
                    };
                }),
                seats: (m.seats || []).map(function (q) {
                    return { x: q.x, y: q.y, w: q.width, h: q.height, rot: q.rotationDegrees,
                             section: q.sectionName, r: q.rowOffset, sectionIndex: q.sectionIndex };
                }),
                tables: (m.tables || []).map(function (t) {
                    return { x: t.x, y: t.y, w: t.width, d: t.depth, z: t.z,
                             height: t.objectHeight, rot: t.rotationDegrees,
                             objectType: t.objectType || "TABLE",
                             shape: t.shape, label: t.label };
                })
            };
        }

        function apply() {
            if (!picker || !picker.value) { setStatus("Pick a preset to apply."); return; }
            if (!editing) { setStatus("Turn on Edit mode before applying a preset."); return; }
            setStatus("Loading preset…");
            fetch("/layout-presets/" + picker.value, { headers: { "Accept": "application/json" } })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (preset) {
                    if (!preset) { setStatus("Could not load that preset."); return; }
                    var block = toBlock(preset);
                    // Try a few drop points, starting near the canvas centre.
                    var cw = parseInt(canvas.dataset.w, 10) || 900;
                    var ch = parseInt(canvas.dataset.h, 10) || 600;
                    var cx = Math.max(20, Math.round(cw / 2 - block.width / 2));
                    var cy = Math.max(20, Math.round(ch / 2 - block.height / 2));
                    var spots = [{ dx: cx, dy: cy }];
                    for (var step = 1; step <= 6; step++) {
                        spots.push({ dx: cx, dy: Math.max(20, cy + step * (block.height + 20)) });
                        spots.push({ dx: Math.max(20, cx + step * (block.width + 20)), dy: cy });
                    }
                    stampBlock(block, spots, "Applied preset — ");
                })
                .catch(function () { setStatus("Could not reach the server to load the preset."); });
        }

        function remove() {
            if (!picker || !picker.value) { setStatus("Pick a preset to delete."); return; }
            var label = picker.options[picker.selectedIndex].textContent;
            if (!window.confirm("Delete the preset “" + label + "”? This cannot be undone.")) { return; }
            fetch("/layout-presets/" + picker.value, { method: "DELETE", headers: headers() })
                .then(function (r) {
                    setStatus(r.ok ? "Preset deleted." : "Could not delete that preset.");
                    if (r.ok) { picker.value = ""; refresh(); }
                })
                .catch(function () { setStatus("Could not reach the server."); });
        }

        if (btnSave) { btnSave.addEventListener("click", save); }
        if (btnApply) { btnApply.addEventListener("click", apply); }
        if (btnDelete) { btnDelete.addEventListener("click", remove); }

        return {
            refresh: function () { if (!loaded) { refresh(); } }
        };
    })();

    // --- Right-side group outliner -------------------------------------------
    function renderOutliner() {
        var panel = document.getElementById("groupOutliner");
        if (!panel) { return; }
        var list = document.getElementById("groupOutlinerList");
        var empty = document.getElementById("groupOutlinerEmpty");
        var count = document.getElementById("groupOutlinerCount");
        var groups = Groups.all();
        panel.classList.toggle("hidden", !editing || groups.length === 0);
        if (count) { count.textContent = groups.length; }
        if (empty) { empty.classList.toggle("hidden", groups.length > 0); }
        if (!list) { return; }
        list.textContent = "";
        groups.forEach(function (g) {
            var row = document.createElement("div");
            row.className = "group-row" + (groupHasSelection(g) ? " active" : "");

            var sw = document.createElement("span");
            sw.className = "group-swatch";
            sw.style.background = groupColor(g);
            row.appendChild(sw);

            var name = document.createElement("input");
            name.className = "group-name";
            name.type = "text";
            name.value = g.name;
            name.spellcheck = false;
            name.addEventListener("click", function (e) { e.stopPropagation(); });
            name.addEventListener("change", function () {
                g.name = name.value.trim() || g.name;
                name.value = g.name;
                renderAll();
                markDirty();
            });
            row.appendChild(name);

            var cnt = document.createElement("span");
            cnt.className = "group-count";
            cnt.textContent = memberSummary(g);
            row.appendChild(cnt);

            var un = document.createElement("button");
            un.className = "group-ungroup";
            un.type = "button";
            un.title = "Ungroup";
            un.setAttribute("aria-label", "Ungroup " + g.name);
            un.textContent = "✕";
            un.addEventListener("click", function (e) {
                e.stopPropagation();
                Groups.remove(g);
                renderOutliner();
                renderAll();
                refreshCommandState();
                markDirty();
                notify();
            });
            row.appendChild(un);

            row.addEventListener("click", function () { selectGroup(g, null); });
            list.appendChild(row);
        });
    }

    function groupHasSelection(g) {
        return selection.some(function (s) { return g.members.sections.indexOf(s.key) !== -1; });
    }

    function groupColor(g) {
        var first = sectionsInGroup(g)[0];
        return first ? first.color : "#6b7280";
    }

    function memberSummary(g) {
        var parts = [];
        if (g.members.sections.length) { parts.push(g.members.sections.length + "◧"); }
        if (g.members.seats.length) { parts.push(g.members.seats.length + "◦"); }
        if (g.members.tables.length) { parts.push(g.members.tables.length + "▦"); }
        return parts.join("  ");
    }

    function refreshInspector() {
        if (inFee) { inFee.value = selected?.serviceFeePerTicket ?? ""; }
        if (!inspector) { return; }
        if (!selected) { inspector.classList.add("hidden"); return; }
        inspector.classList.remove("hidden");
        inName.value = selected.name || "";
        inMode.value = selected.mode;
        inCurrency.value = selected.currency || "";
        inCapacity.value = selected.capacity != null ? selected.capacity : "";
        inColor.value = toHex(selected.color);
        if (capField) { capField.classList.toggle("hidden", selected.mode !== "GENERAL_ADMISSION"); }
    }

    bind(inFee, "change", function () {
        if (!inFee.checkValidity()) { inFee.reportValidity(); return; }
        selected.serviceFeePerTicket = inFee.value === "" ? 1 : inFee.valueAsNumber;
        markDirty();
    });
    bind(inName, "input", function () { selected.name = inName.value; renderAll(); markDirty(); });
    bind(inMode, "change", function () {
        selected.mode = inMode.value === "GENERAL_ADMISSION" ? "GENERAL_ADMISSION" : "SEATED";
        refreshInspector(); renderAll(); markDirty();
    });
    bind(inCurrency, "input", function () { selected.currency = inCurrency.value; markDirty(); });
    bind(inCapacity, "input", function () { selected.capacity = inCapacity.value === "" ? null : parseInt(inCapacity.value, 10); markDirty(); });
    bind(inColor, "input", function () { selected.color = inColor.value; renderAll(); markDirty(); });
    if (btnDel) {
        btnDel.addEventListener("click", function () { deleteSelected(); });
    }
    if (btnCopy) { btnCopy.addEventListener("click", function () { copySelected(); }); }
    if (btnPaste) { btnPaste.addEventListener("click", function () { pasteClipboard(); }); }
    if (btnDuplicate) { btnDuplicate.addEventListener("click", function () { duplicateSelected(); }); }
    if (btnGroup) { btnGroup.addEventListener("click", function () { groupSelection(); }); }
    if (btnUngroup) { btnUngroup.addEventListener("click", function () { ungroupSelection(); }); }
    if (btnSelectAll) { btnSelectAll.addEventListener("click", function () { selectAll(); }); }

    function deleteSelected() {
        if (!selection.length) { return; }
        var doomed = selection.slice();
        // Drop them from any groups, then discard groups that fall below two members.
        groupList.forEach(function (g) {
            g.members.sections = g.members.sections.filter(function (k) {
                return !doomed.some(function (s) { return s.key === k; });
            });
        });
        groupList = groupList.filter(function (g) {
            return g.members.sections.length + g.members.seats.length + g.members.tables.length > 1;
        });
        sections = sections.filter(function (s) { return doomed.indexOf(s) === -1; });
        setSelection([]);
        markDirty();
    }

    // --- Copy / paste ---------------------------------------------------------
    // The clipboard holds the whole selection — sections AND the seats/tables selected with them —
    // so copying a section with its chairs reproduces the entire arrangement. Everything is stored
    // relative to the selection's bounding box, so one offset repositions the block as a unit.
    // Captures whatever is selected right now as a self-contained block: sections + the seats and
    // tables selected with them, every coordinate relative to the block's bounding box. This is the
    // single source of truth for both the clipboard and "Save as preset" — a preset is simply a
    // captured block given a name and persisted. Returns null when nothing is selected.
    function captureSelection() {
        var seatSel = seatSelection();
        var st = null;
        if (window.HallSeatEditor) { try { st = window.HallSeatEditor.getState(); } catch (e) { st = null; } }
        var seats = [], tables = [];
        if (st) {
            (st.seats || []).forEach(function (q) {
                if (seatSel.seats.indexOf(q.key) !== -1 || selection.some(function (section) {
                    return section.mode === "SEATED" && section.key === q.sectionKey;
                })) { seats.push(q); }
            });
            (st.tables || []).forEach(function (t) {
                if (seatSel.tables.indexOf(t.key) !== -1 || selection.some(function (section) {
                    return containsPoint(section.points, t.x + t.w / 2, t.y + t.d / 2);
                })) { tables.push(t); }
            });
        }
        if (!selection.length && !seats.length && !tables.length) { return null; }

        var box = selectionBounds(selection, seats, tables);
        return {
            width: box.maxX - box.minX,
            height: box.maxY - box.minY,
            // Where the block was captured from. Points below are bbox-relative (so a preset can be
            // stamped anywhere); paste re-adds this origin to land beside the source.
            originX: box.minX,
            originY: box.minY,
            sections: selection.map(function (s) {
                return {
                    name: s.name, mode: s.mode, currency: s.currency,
                    capacity: s.capacity, serviceFeePerTicket: s.serviceFeePerTicket, color: s.color, shapeKind: s.shapeKind,
                    points: s.points.map(function (p) { return [p[0] - box.minX, p[1] - box.minY]; })
                };
            }),
            seats: seats.map(function (q) {
                return { x: q.x - box.minX, y: q.y - box.minY, w: q.w, h: q.h,
                         rot: q.rot, section: q.section, r: q.r,
                         sectionIndex: selection.findIndex(function (section) { return section.key === q.sectionKey; }) };
            }),
            tables: tables.map(function (t) {
                return { x: t.x - box.minX, y: t.y - box.minY, w: t.w, d: t.d,
                         z: t.z, height: t.height, rot: t.rot,
                         objectType: t.objectType || "TABLE", shape: t.shape, label: t.label };
            })
        };
    }

    function copySelected() {
        var block = captureSelection();
        if (!block) {
            setStatus("Select a seat, section, table, or screen first.");
            return;
        }
        clipboard = block;
        refreshCommandState();
        setStatus("Copied " + describe(clipboard) + ".");
    }

    function duplicateSelected() {
        var block = captureSelection();
        if (!block) {
            setStatus("Select a seat, section, table, or screen first.");
            return;
        }
        clipboard = block;
        refreshCommandState();
        pasteClipboard();
    }

    // Pastes the clipboard as new unsaved drafts. Everything lands beside the original (offset by
    // the block's own width) so pasted seats never trip the overlap validator; if that spot is
    // rejected we drop the block below instead. Nothing is sent to the server — the pasted items
    // are ordinary drafts that the normal "Save layout" persists.
    function pasteClipboard() {
        if (!clipboard) {
            setStatus("Copy a selection before pasting.");
            return;
        }
        var gap = 20;
        // Keep duplicated blocks horizontally aligned with their source. The right side is only a
        // fallback when the space directly below cannot accept the copied seats.
        var ox = clipboard.originX, oy = clipboard.originY;
        stampBlock(clipboard, [
            { dx: ox, dy: oy + clipboard.height + gap },
            { dx: ox + clipboard.width + gap, dy: oy },
            { dx: ox + gap, dy: oy + gap }
        ], "Pasted");
    }

    // Creates a captured block as new unsaved drafts at the first drop point whose seats fit (the
    // seat validator rejects overlaps, so we try each candidate in turn). Shared by paste and by
    // applying a saved preset. Nothing is sent to the server: everything is an ordinary draft that
    // the normal "Save layout" persists.
    function stampBlock(block, spots, verb) {
        spots = spots.filter(function (spot) {
            var candidates = block.sections.map(function (section) {
                return { points: section.points.map(function (point) {
                    return [point[0] + spot.dx, point[1] + spot.dy];
                }) };
            });
            return !sectionsOverlap(candidates, sections);
        });
        if (!spots.length) {
            setStatus("No free space for the sections.");
            return false;
        }
        var seatKeys = [];
        var placed = spots[0];
        if (block.seats.length && window.HallSeatEditor && window.HallSeatEditor.createSeats) {
            for (var i = 0; i < spots.length; i++) {
                var spot = spots[i];
                seatKeys = window.HallSeatEditor.createSeats(block.seats.map(function (q) {
                    return { x: q.x + spot.dx, y: q.y + spot.dy, w: q.w, h: q.h,
                             rot: q.rot, section: q.section, r: q.r };
                }));
                if (seatKeys.length) { placed = spot; break; }
            }
            if (!seatKeys.length) {
                setStatus("No free space for the seats — clear some room and try again.");
                return false;
            }
        }

        var tableKeys = [];
        if (block.tables.length && window.HallSeatEditor && window.HallSeatEditor.createTables) {
            tableKeys = window.HallSeatEditor.createTables(block.tables.map(function (t) {
                return { x: t.x + placed.dx, y: t.y + placed.dy, w: t.w, d: t.d,
                         z: t.z, height: t.height, rot: t.rot,
                         objectType: t.objectType || "TABLE", shape: t.shape, label: t.label };
            }));
            if (tableKeys.length && window.HallSeatEditor.selectTable) {
                window.HallSeatEditor.selectTable(tableKeys[tableKeys.length - 1]);
            }
        }

        var fresh = block.sections.map(function (src) {
            var s = {
                key: "sdraft:" + nextDraftKey++, id: null,
                name: uniqueName(src.name), mode: src.mode,
                currency: src.currency, capacity: src.capacity, serviceFeePerTicket: src.serviceFeePerTicket,
                color: src.color || PALETTE[sections.length % PALETTE.length],
                shapeKind: src.shapeKind || "POLYGON",
                points: src.points.map(function (p) { return [p[0] + placed.dx, p[1] + placed.dy]; })
            };
            sections.push(s);
            return s;
        });
        if (seatKeys.length) {
            var placements = new Map(window.HallSeatEditor.getState().seats.map(function (seat) {
                return [seat.key, seat];
            }));
            var assignments = seatKeys.map(function (key, index) {
                var source = block.seats[index];
                var seat = placements.get(key);
                var section = source.sectionIndex == null
                    ? fresh.find(function (candidate, i) {
                        return candidate.mode === "SEATED" && block.sections[i].name === source.section;
                    }) || fresh.find(function (candidate) {
                        return candidate.mode === "SEATED" && containsPoint(candidate.points,
                            seat.x + seat.w / 2, seat.y + seat.h / 2);
                    })
                    : fresh[source.sectionIndex];
                return { key: key, section: section ? section.name : "", sectionKey: section ? section.key : "" };
            });
            window.HallSeatEditor.applySeatSectionPatch(assignments, { transient: true });
        }
        ensureSectionsFit(fresh);
        // Keep the new seats selected alongside the new sections.
        setSelection(fresh, { additive: true });
        refreshCommandState();
        markDirty();
        setStatus(verb + " " + describe(block) + ".");
        return true;
    }

    // Bounding box over a mixed set of sections, seats and tables (layout-pixel space).
    function selectionBounds(secs, seats, tables) {
        var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        function add(x1, y1, x2, y2) {
            if (x1 < b.minX) { b.minX = x1; }
            if (y1 < b.minY) { b.minY = y1; }
            if (x2 > b.maxX) { b.maxX = x2; }
            if (y2 > b.maxY) { b.maxY = y2; }
        }
        secs.forEach(function (s) {
            var sb = bbox(s.points);
            add(sb.minX, sb.minY, sb.maxX, sb.maxY);
        });
        seats.forEach(function (q) { add(q.x, q.y, q.x + q.w, q.y + q.h); });
        tables.forEach(function (t) { add(t.x, t.y, t.x + t.w, t.y + t.d); });
        if (b.minX === Infinity) { return { minX: 0, minY: 0, maxX: 0, maxY: 0 }; }
        return b;
    }

    function ensureSectionsFit(items) {
        if (!items || !items.length || !window.HallSeatEditor ||
                !window.HallSeatEditor.ensureLayoutBounds) {
            return false;
        }
        var box = selectionBounds(items, [], []);
        return window.HallSeatEditor.ensureLayoutBounds({
            right: box.maxX,
            bottom: box.maxY
        });
    }

    function describe(c) {
        var parts = [];
        if (c.sections.length) { parts.push(c.sections.length + " section(s)"); }
        if (c.seats.length) { parts.push(c.seats.length + " seat(s)"); }
        if (c.tables.length) { parts.push(c.tables.length + " object(s)"); }
        return parts.join(" + ");
    }

    // Sections are matched to server ids by name, so a copy needs a distinct name.
    function uniqueName(base) {
        var name = base + " copy", n = 2;
        var taken = function (v) { return sections.some(function (s) { return s.name === v; }); };
        while (taken(name)) { name = base + " copy " + (n++); }
        return name;
    }

    // --- Keyboard: copy/paste, arrow-nudge, delete ----------------------------
    document.addEventListener("keydown", function (e) {
        if (!editing) { return; }
        // Don't hijack typing in the inspector fields.
        var t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
            return;
        }
        var mod = e.ctrlKey || e.metaKey;
        var k = e.key.toLowerCase();
        if (mod && k === "a") { selectAll(); e.preventDefault(); return; }
        if (mod && k === "g" && e.shiftKey) { ungroupSelection(); e.preventDefault(); return; }
        if (mod && k === "g") { groupSelection(); e.preventDefault(); return; }
        if (mod && k === "c") { copySelected(); e.preventDefault(); return; }
        if (mod && k === "v") { pasteClipboard(); e.preventDefault(); return; }
        if (mod && k === "d") { duplicateSelected(); e.preventDefault(); return; }
        if ((e.key === "Delete" || e.key === "Backspace") && selection.length) { deleteSelected(); e.preventDefault(); return; }

        if (!selection.length) { return; }
        var step = e.shiftKey ? 10 : 1;
        var dx = 0, dy = 0;
        if (e.key === "ArrowLeft") { dx = -step; }
        else if (e.key === "ArrowRight") { dx = step; }
        else if (e.key === "ArrowUp") { dy = -step; }
        else if (e.key === "ArrowDown") { dy = step; }
        else { return; }
        nudgeSelection(dx, dy);
        e.preventDefault();
    });

    // Moves every selected section by (dx,dy), and any seats/tables grouped with them.
    function nudgeSelection(dx, dy) {
        var candidates = selection.map(function (section) {
            return { points: section.points.map(function (p) { return [p[0] + dx, p[1] + dy]; }) };
        });
        if (sectionsOverlap(candidates, sections.filter(function (section) { return !isSel(section); }))) {
            setStatus("Sections cannot overlap.");
            return;
        }
        selection.forEach(function (section, index) { section.points = candidates[index].points; });
        applyBaseline(groupedBaseline(selection), dx, dy, false);
        renderAll();
        markDirty();
    }

    function polygonsOverlap(a, b) {
        if (a.length < 3 || b.length < 3) { return false; }
        var first = bbox(a), second = bbox(b);
        if (first.maxX <= second.minX || second.maxX <= first.minX
            || first.maxY <= second.minY || second.maxY <= first.minY) { return false; }

        function side(p, q, r) {
            return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
        }
        // A proper crossing gives the interiors a shared area.
        if (a.some(function (p, i) {
            var q = a[(i + 1) % a.length];
            return b.some(function (r, j) {
                var t = b[(j + 1) % b.length];
                return side(p, q, r) * side(p, q, t) < 0 && side(r, t, p) * side(r, t, q) < 0;
            });
        })) { return true; }

        // Between vertex heights the edges cannot change order without crossing.
        // Compare filled intervals to catch containment and coincident boundaries.
        function crossings(points, y) {
            var xs = [];
            points.forEach(function (p, i) {
                var q = points[(i + 1) % points.length];
                if ((p[1] > y) !== (q[1] > y)) {
                    xs.push(p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]));
                }
            });
            return xs.sort(function (x, z) { return x - z; });
        }
        var heights = [...new Set(a.concat(b).map(function (p) { return p[1]; }))].sort(function (y, z) { return y - z; });
        for (var n = 1; n < heights.length; n++) {
            var y = (heights[n - 1] + heights[n]) / 2;
            var left = crossings(a, y), right = crossings(b, y);
            for (var i = 0, j = 0; i + 1 < left.length && j + 1 < right.length;) {
                if (Math.min(left[i + 1], right[j + 1]) - Math.max(left[i], right[j]) > 1e-8) {
                    return true;
                }
                if (left[i + 1] < right[j + 1]) { i += 2; } else { j += 2; }
            }
        }
        return false;
    }

    function sectionsOverlap(items, neighbors) {
        return items.some(function (item, index) {
            return neighbors.some(function (other) { return polygonsOverlap(item.points, other.points); })
                || items.slice(0, index).some(function (other) { return polygonsOverlap(item.points, other.points); });
        });
    }

    function placeNewSections(polygons) {
        var candidates = polygons.map(function (points) { return { points: points }; });
        if (!sectionsOverlap(candidates, sections)) { return polygons; }
        var offset = selectionBounds(sections, [], []).maxX + 24
            - selectionBounds(candidates, [], []).minX;
        return polygons.map(function (points) {
            return points.map(function (point) { return [point[0] + offset, point[1]]; });
        });
    }

    function applySectionPoints(section, points) {
        if (sections.some(function (other) {
            return other !== section && polygonsOverlap(points, other.points);
        })) {
            setStatus("Sections cannot overlap.");
            return false;
        }
        section.points = points;
        return true;
    }

    function alignmentTargets(excluded) {
        var w = parseInt(canvas.dataset.w, 10) || 900;
        var h = parseInt(canvas.dataset.h, 10) || 600;
        var targets = { x: [w / 2], y: [h / 2] };
        var stage = canvas.querySelector(".stage-abs");
        if (stage) {
            targets.x.push(stage.offsetLeft - stage.offsetWidth / 2,
                stage.offsetLeft + stage.offsetWidth / 2);
            targets.y.push(stage.offsetTop, stage.offsetTop + stage.offsetHeight);
        }
        sections.forEach(function (section) {
            if (excluded.indexOf(section) !== -1 || !section.points.length) { return; }
            var box = bbox(section.points);
            targets.x.push(box.minX, (box.minX + box.maxX) / 2, box.maxX);
            targets.y.push(box.minY, (box.minY + box.maxY) / 2, box.maxY);
        });
        return targets;
    }

    function snapAxis(axis, positions, offset, targets, bypass) {
        delete activeGuides[axis];
        if (bypass) { return offset; }
        var rect = canvas.getBoundingClientRect();
        var scale = axis === "x" ? rect.width / (parseInt(canvas.dataset.w, 10) || 900)
            : rect.height / (parseInt(canvas.dataset.h, 10) || 600);
        var nearest = 7 / (scale || 1);
        var correction = 0;
        targets[axis].forEach(function (target) {
            positions.forEach(function (position) {
                var delta = target - position - offset;
                if (Math.abs(delta) < nearest) {
                    nearest = Math.abs(delta);
                    correction = delta;
                    activeGuides[axis] = target;
                }
            });
        });
        return offset + correction;
    }

    // Match both endpoints with one translation so the shared edge keeps its length and angle.
    function snapSharedEdge(movers, fixed, dx, dy, toleranceX, toleranceY) {
        function winding(points) {
            return Math.sign(points.reduce(function (area, a, i) {
                var b = points[(i + 1) % points.length];
                return area + a[0] * b[1] - a[1] * b[0];
            }, 0));
        }
        var best = null, distance = 1;
        var neighbors = fixed.map(function (section) {
            return { points: section.points, side: winding(section.points) };
        });
        movers.forEach(function (moving) {
            var side = winding(moving.pts);
            if (!side) { return; }
            moving.pts.forEach(function (a, i) {
                var b = moving.pts[(i + 1) % moving.pts.length];
                if (a[0] === b[0] && a[1] === b[1]) { return; }
                neighbors.forEach(function (neighbor) {
                    if (!neighbor.side) { return; }
                    neighbor.points.forEach(function (c, j) {
                        var d = neighbor.points[(j + 1) % neighbor.points.length];
                        // Match edges only when the section interiors face opposite sides.
                        var edge = side === neighbor.side ? [d, c] : [c, d];
                        var x = edge[0][0] - a[0], y = edge[0][1] - a[1];
                        if (b[0] + x !== edge[1][0] || b[1] + y !== edge[1][1]) { return; }
                        var delta = Math.hypot((x - dx) / toleranceX, (y - dy) / toleranceY);
                        if (delta < distance) {
                            distance = delta;
                            best = { dx: x, dy: y, edge: edge };
                        }
                    });
                });
            });
        });
        return best;
    }

    function renderGuides(w, h) {
        function line(axis, pos, active) {
            var guide = document.createElementNS(SVG_NS, "line");
            guide.setAttribute("x1", axis === "x" ? pos : 0);
            guide.setAttribute("x2", axis === "x" ? pos : w);
            guide.setAttribute("y1", axis === "y" ? pos : 0);
            guide.setAttribute("y2", axis === "y" ? pos : h);
            guide.setAttribute("stroke", active ? "#d024a0" : "#657995");
            guide.setAttribute("stroke-width", active ? "1.5" : "1");
            guide.setAttribute("vector-effect", "non-scaling-stroke");
            guide.setAttribute("pointer-events", "none");
            if (!active) {
                guide.setAttribute("stroke-dasharray", "5 5");
                guide.setAttribute("opacity", "0.65");
            }
            svg.appendChild(guide);
        }
        line("x", w / 2, false);
        if (activeGuides.edge) {
            var edge = activeGuides.edge;
            var shared = document.createElementNS(SVG_NS, "line");
            shared.setAttribute("x1", edge[0][0]);
            shared.setAttribute("y1", edge[0][1]);
            shared.setAttribute("x2", edge[1][0]);
            shared.setAttribute("y2", edge[1][1]);
            shared.setAttribute("stroke", "#d024a0");
            shared.setAttribute("stroke-width", "3");
            shared.setAttribute("vector-effect", "non-scaling-stroke");
            shared.setAttribute("pointer-events", "none");
            svg.appendChild(shared);
        }
        ["x", "y"].forEach(function (axis) {
            if (activeGuides[axis] !== undefined) { line(axis, activeGuides[axis], true); }
        });
    }

    function clearGuides() {
        activeGuides = {};
        renderAll();
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
            var sel = isSel(s);
			// Safely checks if Groups and Groups.groupOf exist before calling it
			var grouped = Groups?.groupOf ? Groups.groupOf("section", s?.key) : null;
            var poly = document.createElementNS(SVG_NS, "polygon");
            poly.setAttribute("points", s.points.map(function (p) { return p[0] + "," + p[1]; }).join(" "));
            poly.setAttribute("fill", withAlpha(s.color, sel ? 0.34 : 0.18));
            poly.setAttribute("stroke", s.color);
            poly.setAttribute("stroke-width", sel ? 2.5 : 1.5);
            if (grouped) { poly.setAttribute("stroke-dasharray", "8 3"); }
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
            label.textContent = s.name + (s.mode === "GENERAL_ADMISSION" ? " (GA)" : "")
                + (grouped ? "  ⛓ " + grouped.name : "");
            label.style.pointerEvents = "none";
            svg.appendChild(label);

            // Transform handles only make sense for a single, ungrouped-or-primary selection.
            if (s === selected && selection.length === 1 && editing) {
                var bb = bbox(s.points);
                // Dashed bounding box so the symmetric resize is easy to read.
                var frame = document.createElementNS(SVG_NS, "rect");
                frame.setAttribute("x", bb.minX); frame.setAttribute("y", bb.minY);
                frame.setAttribute("width", bb.maxX - bb.minX); frame.setAttribute("height", bb.maxY - bb.minY);
                frame.setAttribute("fill", "none");
                frame.setAttribute("stroke", s.color);
                frame.setAttribute("stroke-width", 1);
                frame.setAttribute("stroke-dasharray", "5 4");
                frame.setAttribute("opacity", 0.6);
                frame.style.pointerEvents = "none";
                svg.appendChild(frame);

                // Edge handles sit at each side's midpoint. Only drawn for shapes with few
                // enough sides to aim at — a 48-segment circle would be a ring of confetti.
                if (s.points.length <= EDGE_HANDLE_LIMIT) {
                    s.points.forEach(function (p, idx) {
                        var q = s.points[(idx + 1) % s.points.length];
                        var mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
                        var edge = document.createElementNS(SVG_NS, "rect");
                        // A diamond, so it never reads as another draggable vertex.
                        edge.setAttribute("x", mx - 4.5); edge.setAttribute("y", my - 4.5);
                        edge.setAttribute("width", 9); edge.setAttribute("height", 9);
                        edge.setAttribute("transform", "rotate(45 " + mx + " " + my + ")");
                        edge.setAttribute("fill", "#ffffff");
                        edge.setAttribute("stroke", s.color);
                        edge.setAttribute("stroke-width", 1.5);
                        edge.style.pointerEvents = "all";
                        edge.style.cursor = "grab";
                        var label = document.createElementNS(SVG_NS, "title");
                        label.textContent = "Drag this edge · Shift+click to remove · Alt+click to fold";
                        edge.appendChild(label);
                        edge.addEventListener("pointerdown", function (e) {
                            startSideDrag(e, s, idx);
                        });
                        svg.appendChild(edge);
                    });
                }

                s.points.forEach(function (p, idx) {
                    var dot = document.createElementNS(SVG_NS, "circle");
                    dot.setAttribute("cx", p[0]); dot.setAttribute("cy", p[1]); dot.setAttribute("r", 6);
                    dot.setAttribute("class", "section-handle");
                    dot.style.pointerEvents = "all";
                    dot.style.cursor = "grab";
                    dot.addEventListener("pointerdown", function (e) { startVertex(e, s, idx); });
                    svg.appendChild(dot);
                });

                // Symmetric resize handle at the bounding-box corner: drag to scale the whole
                // shape uniformly about its centre (aspect ratio preserved).
                var grip = document.createElementNS(SVG_NS, "rect");
                grip.setAttribute("x", bb.maxX - 6); grip.setAttribute("y", bb.maxY - 6);
                grip.setAttribute("width", 12); grip.setAttribute("height", 12);
                grip.setAttribute("rx", 2);
                grip.setAttribute("fill", "#ffffff");
                grip.setAttribute("stroke", s.color);
                grip.setAttribute("stroke-width", 2);
                grip.style.pointerEvents = "all";
                grip.style.cursor = "nwse-resize";
                grip.addEventListener("pointerdown", function (e) { startResize(e, s); });
                svg.appendChild(grip);

                // Edge handles at the box side midpoints: drag one to stretch the shape along a
                // single axis, keeping the opposite edge anchored ("extend just this side").
                var midX = (bb.minX + bb.maxX) / 2, midY = (bb.minY + bb.maxY) / 2;
                [
                    { dir: "e", x: bb.maxX, y: midY, cursor: "ew-resize" },
                    { dir: "w", x: bb.minX, y: midY, cursor: "ew-resize" },
                    { dir: "s", x: midX, y: bb.maxY, cursor: "ns-resize" },
                    { dir: "n", x: midX, y: bb.minY, cursor: "ns-resize" }
                ].forEach(function (h) {
                    var edge = document.createElementNS(SVG_NS, "rect");
                    edge.setAttribute("x", h.x - 5); edge.setAttribute("y", h.y - 5);
                    edge.setAttribute("width", 10); edge.setAttribute("height", 10);
                    edge.setAttribute("rx", 2);
                    edge.setAttribute("fill", s.color);
                    edge.setAttribute("stroke", "#ffffff");
                    edge.setAttribute("stroke-width", 1.5);
                    edge.style.pointerEvents = "all";
                    edge.style.cursor = h.cursor;
                    edge.addEventListener("pointerdown", function (e) { startEdge(e, s, h.dir); });
                    svg.appendChild(edge);
                });

                // Rotation handle above the box centre: drag around the centre to spin the shape.
                var topX = (bb.minX + bb.maxX) / 2, topY = bb.minY;
                var stem = document.createElementNS(SVG_NS, "line");
                stem.setAttribute("x1", topX); stem.setAttribute("y1", topY);
                stem.setAttribute("x2", topX); stem.setAttribute("y2", topY - 28);
                stem.setAttribute("stroke", s.color);
                stem.setAttribute("stroke-width", 1);
                stem.setAttribute("opacity", 0.6);
                stem.style.pointerEvents = "none";
                svg.appendChild(stem);

                var rot = document.createElementNS(SVG_NS, "circle");
                rot.setAttribute("cx", topX); rot.setAttribute("cy", topY - 28); rot.setAttribute("r", 7);
                rot.setAttribute("fill", "#ffffff");
                rot.setAttribute("stroke", s.color);
                rot.setAttribute("stroke-width", 2);
                rot.style.pointerEvents = "all";
                rot.style.cursor = "grab";
                rot.addEventListener("pointerdown", function (e) { startRotate(e, s); });
                svg.appendChild(rot);
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

        // The seat editor draws its own marquee overlay for the same drag; only draw ours when it
        // isn't there, so the user never sees two rectangles.
        if (marquee && !window.HallSeatEditor) {
            var b = marquee.box;
            var mr = document.createElementNS(SVG_NS, "rect");
            mr.setAttribute("x", b.minX); mr.setAttribute("y", b.minY);
            mr.setAttribute("width", b.maxX - b.minX); mr.setAttribute("height", b.maxY - b.minY);
            mr.setAttribute("fill", "rgba(59,130,246,0.12)");
            mr.setAttribute("stroke", "#3b82f6");
            mr.setAttribute("stroke-width", 1);
            mr.setAttribute("stroke-dasharray", "4 3");
            mr.style.pointerEvents = "none";
            svg.appendChild(mr);
        }
        if (editing && !window.SeatBoundsOverride) { renderGuides(w, h); }
    }

    // --- Drag: whole section (+ any co-selected/grouped members) --------------
    function startMove(e, s) {
        if (!editing || draft) { return; }
        e.preventDefault();
        e.stopPropagation();
        // Ctrl/Shift toggles membership instead of starting a drag.
        if (e.ctrlKey || e.metaKey || e.shiftKey) { toggleSel(s); return; }
        // Alt+click drills into a group: selects just this section so it can be edited (and moved)
        // on its own without ungrouping.
        if (e.altKey) { selectSolo(s); }
        // Clicking an unselected section selects it (expanding to its group); keep an existing
        // multi-selection intact if this section is already part of it.
        else if (!isSel(s) || (soloKey && soloKey !== s.key)) { soloKey = null; select(s); }
        var movers = selection.slice();
        var box = selectionBounds(movers, [], []);
        var targets = alignmentTargets(movers);
        var fixed = sections.filter(function (section) { return movers.indexOf(section) === -1; })
            .map(function (section) { return { points: section.points }; });
        var addedLeft = 0;
        var rect = canvas.getBoundingClientRect();
        var toleranceX = 7 * (parseInt(canvas.dataset.w, 10) || 900) / Math.max(1, rect.width);
        var toleranceY = 7 * (parseInt(canvas.dataset.h, 10) || 600) / Math.max(1, rect.height);
        var unitsX = toleranceX / 7, unitsY = toleranceY / 7;
        var shell = canvas.parentElement;
        var scrollX = shell.scrollLeft, scrollY = shell.scrollTop;
        var orig = movers.map(function (m) { return { s: m, pts: m.points.map(function (p) { return [p[0], p[1]]; }) }; });
        var base = groupedBaseline(movers, { carrySectionSeats: true });
        var minX = Math.min(box.minX, ...base.seats.map(function (q) { return q.x; }),
            ...base.tables.map(function (q) { return q.x; }));
        var minY = Math.min(box.minY, ...base.seats.map(function (q) { return q.y; }),
            ...base.tables.map(function (q) { return q.y; }));
        var last = { dx: 0, dy: 0 };
        function move(ev) {
            var dx = (ev.clientX - e.clientX + shell.scrollLeft - scrollX) * unitsX;
            var dy = (ev.clientY - e.clientY + shell.scrollTop - scrollY) * unitsY;
            activeGuides = {};
            var match = ev.altKey ? null : snapSharedEdge(orig, fixed, dx, dy, toleranceX, toleranceY);
            if (match) {
                dx = match.dx;
                dy = match.dy;
                activeGuides.edge = match.edge;
            } else {
                dx = snapAxis("x", [(box.minX + box.maxX) / 2, box.minX, box.maxX], dx, targets, ev.altKey);
                dy = snapAxis("y", [(box.minY + box.maxY) / 2, box.minY, box.maxY], dy, targets, ev.altKey);
            }
            var nextY = Math.max(dy, -minY);
            if (nextY !== dy) { activeGuides = {}; }
            dy = nextY;
            var candidates = orig.map(function (item) {
                return { points: item.pts.map(function (pt) {
                    return [Math.round(pt[0] + dx + addedLeft), Math.round(pt[1] + dy)];
                }) };
            });
            if (sectionsOverlap(candidates, sections.filter(function (section) {
                return movers.indexOf(section) === -1;
            }))) {
                clearGuides();
                setStatus("Sections cannot overlap.");
                return;
            }
            var needed = Math.max(0, Math.ceil(-(minX + dx + addedLeft)));
            if (needed) {
                // Rebase all coordinates together so persisted positions stay nonnegative.
                sections.forEach(function (section) {
                    section.points = section.points.map(function (pt) { return [pt[0] + needed, pt[1]]; });
                });
                addedLeft += needed;
                window.HallSeatEditor.extendCanvasLeft(needed);
            }
            if (activeGuides.x !== undefined) { activeGuides.x += addedLeft; }
            if (activeGuides.edge) {
                activeGuides.edge = activeGuides.edge.map(function (pt) { return [pt[0] + addedLeft, pt[1]]; });
            }
            last.dx = dx + addedLeft; last.dy = dy;
            orig.forEach(function (o) {
                o.s.points = o.pts.map(function (pt) {
                    return [Math.round(pt[0] + last.dx), Math.round(pt[1] + dy)];
                });
            });
            ensureSectionsFit(movers);
            applyBaseline(base, last.dx, dy, true);
            renderAll();
        }
        function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            applyBaseline(base, last.dx, last.dy, false);   // commit (marks seat layout dirty once)
            clearGuides();
            markDirty();
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    }

    // Snapshot of the seats/tables grouped with `movingSections` and their positions right now,
    // so a drag/nudge can set absolute = start + delta without drift.
    function groupedBaseline(movingSections, options) {
        var out = { seats: [], tables: [] };
        // While drilled into a single member (Alt+click), it moves alone — the rest of its group
        // stays put, which is the whole point of editing one item inside a group.
        if (!window.HallSeatEditor || soloKey) { return out; }
        if (!window.SeatBoundsOverride) {
            if (!options || !options.carrySectionSeats) { return out; }
            var keys = new Set(movingSections.map(function (section) { return section.key; }));
            out.seats = window.HallSeatEditor.getState().seats.filter(function (seat) {
                return keys.has(seat.sectionKey);
            });
            return out;
        }
        var seatKeys = {}, tableKeys = {};
        movingSections.forEach(function (s) {
            var g = Groups.groupOf("section", s.key);
            if (!g) { return; }
            g.members.seats.forEach(function (k) { seatKeys[k] = 1; });
            g.members.tables.forEach(function (k) { tableKeys[k] = 1; });
        });
        var state; try { state = window.HallSeatEditor.getState(); } catch (e) { return out; }
        // Anything currently selected travels too, grouped or not — co-selection is intent enough.
        (state.selectedKeys || []).forEach(function (k) { seatKeys[k] = 1; });
        (state.tables || []).forEach(function (t) { if (t.selected) { tableKeys[t.key] = 1; } });
        var sectionKeys = new Set(movingSections.map(function (section) { return section.key; }));
        (state.seats || []).forEach(function (q) {
            if (seatKeys[q.key] || sectionKeys.has(q.sectionKey)) {
                out.seats.push(q);
            }
        });
        (state.tables || []).forEach(function (q) {
            if (tableKeys[q.key] || movingSections.some(function (section) {
                return containsPoint(section.points, q.x + q.w / 2, q.y + q.d / 2);
            })) { out.tables.push(q); }
        });
        return out;
    }

    function applyBaseline(base, dx, dy, transient) {
        if (!window.HallSeatEditor) { return; }
        if (base.seats.length) {
            window.HallSeatEditor.applySpatialPatch(
                base.seats.map(function (b) { return { key: b.key, x: b.x + dx, y: b.y + dy }; }),
                { transient: transient });
        }
        if (base.tables.length && window.HallSeatEditor.applyTablePatch) {
            window.HallSeatEditor.applyTablePatch(
                base.tables.map(function (b) { return { key: b.key, x: b.x + dx, y: b.y + dy }; }),
                { transient: transient });
        }
    }

    function startSideDrag(e, section, index) {
        if (!editing || draft || e.button !== 0) { return; }
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey || e.shiftKey) {
            if (e.altKey) {
                if (!invertEdge(section, index)) { return; }
                setStatus("Folded the side inward.");
            } else if (!removeEdge(section, index)) {
                return;
            } else {
                setStatus("Removed a side.");
            }
            section.shapeKind = "POLYGON";
            markDirty();
            renderAll();
            return;
        }

        var next = (index + 1) % section.points.length;
        var a = section.points[index], b = section.points[next];
        var length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!length) { return; }
        var normalX = (a[1] - b[1]) / length;
        var normalY = (b[0] - a[0]) / length;
        var start = toCanvas(e);
        var changed = false;
        function move(ev) {
            if (ev.pointerId !== e.pointerId) { return; }
            var cursor = toCanvas(ev);
            var distance = (cursor.x - start.x) * normalX + (cursor.y - start.y) * normalY;
            var dx = Math.round(distance * normalX), dy = Math.round(distance * normalY);
            if (Math.min(a[0], b[0]) + dx < 0 || Math.min(a[1], b[1]) + dy < 0) { return; }
            if (section.points[index][0] === a[0] + dx && section.points[index][1] === a[1] + dy) { return; }
            var points = section.points.slice();
            points[index] = [a[0] + dx, a[1] + dy];
            points[next] = [b[0] + dx, b[1] + dy];
            if (!applySectionPoints(section, points)) { return; }
            section.shapeKind = "POLYGON";
            changed = true;
            ensureSectionsFit([section]);
            renderAll();
        }
        function end(ev) {
            if (ev.pointerId !== e.pointerId) { return; }
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", end);
            window.removeEventListener("pointercancel", end);
            if (changed) { markDirty(); }
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", end);
        window.addEventListener("pointercancel", end);
    }

    // --- Drag: single vertex --------------------------------------------------
    function startVertex(e, s, idx) {
        if (!editing) { return; }
        e.preventDefault();
        e.stopPropagation();
        var targets = alignmentTargets([s]);
        function move(ev) {
            var p = toCanvas(ev);
            var points = s.points.slice();
            points[idx] = [
                Math.round(snapAxis("x", [0], p.x, targets, ev.altKey)),
                Math.round(snapAxis("y", [0], p.y, targets, ev.altKey))
            ];
            if (!applySectionPoints(s, points)) { clearGuides(); return; }
            renderAll();
        }
        function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            clearGuides();
            markDirty();
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    }

    // --- Symmetric resize: scale whole shape about its centre -----------------
    function startResize(e, s) {
        if (!editing || draft) { return; }
        e.preventDefault();
        e.stopPropagation();
        var targets = alignmentTargets([s]);
        var bb = bbox(s.points);
        var cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
        var orig = s.points.map(function (p) { return [p[0], p[1]]; });
        var start = toCanvas(e);
        // Reference distance from centre to the pointer at grab time; the live ratio drives scale.
        var d0 = Math.max(8, Math.hypot(start.x - cx, start.y - cy));
        function move(ev) {
            var p = toCanvas(ev);
            var d1 = Math.hypot(p.x - cx, p.y - cy);
            var scale = d1 / d0;
            // Clamp so a section can't collapse to a dot or explode off-canvas.
            var half = Math.hypot(bb.maxX - cx, bb.maxY - cy);
            if (half * scale < 12) { scale = 12 / half; }
            if (half * scale > 4000) { scale = 4000 / half; }
            var points = orig.map(function (o) {
                return [Math.round(cx + (o[0] - cx) * scale), Math.round(cy + (o[1] - cy) * scale)];
            });
            if (!applySectionPoints(s, points)) { clearGuides(); return; }
            renderAll();
        }
        function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            clearGuides();
            markDirty();
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    // --- Edge resize: stretch one side along a single axis --------------------
    // `dir` is the edge being dragged (e/w = horizontal, n/s = vertical); the opposite edge stays
    // anchored, so only that side moves. Scale is applied about the anchored edge.
    function startEdge(e, s, dir) {
        if (!editing || draft) { return; }
        e.preventDefault();
        e.stopPropagation();
        var targets = alignmentTargets([s]);
        var bb = bbox(s.points);
        var horizontal = (dir === "e" || dir === "w");
        var anchor = dir === "e" ? bb.minX : dir === "w" ? bb.maxX : dir === "s" ? bb.minY : bb.maxY;
        var span = horizontal ? (bb.maxX - bb.minX) : (bb.maxY - bb.minY);
        if (span < 1) { return; }
        var orig = s.points.map(function (p) { return [p[0], p[1]]; });
        function move(ev) {
            var p = toCanvas(ev);
            var pos = horizontal ? p.x : p.y;
            pos = snapAxis(horizontal ? "x" : "y", [0], pos, targets, ev.altKey);
            var scale = (pos - anchor) / (span * ((dir === "w" || dir === "n") ? -1 : 1));
            // Keep the dragged edge on the moving side of the anchor (no inversion) and ≥ ~12px.
            if (span * scale < 12) { scale = 12 / span; }
            if (span * scale > 4000) { scale = 4000 / span; }
            var points = orig.map(function (o) {
                if (horizontal) { return [Math.round(anchor + (o[0] - anchor) * scale), o[1]]; }
                return [o[0], Math.round(anchor + (o[1] - anchor) * scale)];
            });
            if (!applySectionPoints(s, points)) { clearGuides(); return; }
            renderAll();
        }
        function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            clearGuides();
            markDirty();
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    }

    // --- Rotate: spin whole shape about its centre ----------------------------
    function sectionRotation(s) {
        var bb = bbox(s.points);
        var cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
        var orig = s.points.map(function (p) { return p.slice(); });
        var editor = window.SeatBoundsOverride && window.HallSeatEditor;
        var state = editor ? editor.getState() : { seats: [], tables: [] };
        var seats = s.mode === "SEATED" ? state.seats.filter(function (seat) {
            return seat.sectionKey === s.key;
        }) : [];
        var tables = state.tables.filter(function (table) {
            return containsPoint(orig, table.x + table.w / 2, table.y + table.d / 2);
        });
        return function (delta) {
            var cos = Math.cos(delta), sin = Math.sin(delta);
            var degrees = delta * 180 / Math.PI;

            function rotate(x, y) {
                return [cx + (x - cx) * cos - (y - cy) * sin,
                        cy + (x - cx) * sin + (y - cy) * cos];
            }
            function rotateObject(object, height) {
                var center = rotate(object.x + object.w / 2, object.y + height / 2);
                var angle = Math.round(object.rot + degrees);
                return {
                    key: object.key,
                    x: Math.round(center[0] - object.w / 2),
                    y: Math.round(center[1] - height / 2),
                    rot: ((angle % 360) + 540) % 360 - 180
                };
            }

            var points = orig.map(function (point) { return rotate(point[0], point[1]).map(Math.round); });
            var seatPatches = seats.map(function (seat) { return rotateObject(seat, seat.h); });
            var tablePatches = tables.map(function (table) { return rotateObject(table, table.d); });
            // Reject a turn that would clip the section or force individual items
            // to be clamped, which would distort their positions inside the section.
            if (points.some(function (point) { return point[0] < 0 || point[1] < 0; })
                || seatPatches.concat(tablePatches).some(function (patch) { return patch.x < 0 || patch.y < 0; })) {
                return;
            }
            if (!applySectionPoints(s, points)) { return false; }
            ensureSectionsFit([s]);
            if (seatPatches.length) { editor.applySpatialPatch(seatPatches, { transient: true }); }
            if (tablePatches.length) { editor.applyTablePatch(tablePatches, { transient: true }); }
            renderAll();
            return true;
        };
    }

    rotationButtons.forEach(function (button) {
        button.addEventListener("click", function () {
            if (!editing || draft || selection.length !== 1) { return; }
            var degrees = Number(button.dataset.sectionRotation);
            if (degrees === 360) {
                setStatus("360° is a full turn.");
                return;
            }
            if (sectionRotation(selected)(degrees * Math.PI / 180)) {
                markDirty();
                setStatus("Rotated section " + degrees + "° clockwise.");
            } else {
                setStatus("Move the section away from the canvas edge before rotating.");
            }
        });
    });

    mirrorButtons.forEach(function (button) {
        button.addEventListener("click", function () {
            if (!editing || draft || selection.length !== 1) { return; }
            var horizontal = button.dataset.sectionMirror === "horizontal";
            var box = bbox(selected.points);
            var points = selected.points.map(function (point) {
                return horizontal
                    ? [box.minX + box.maxX - point[0], point[1]]
                    : [point[0], box.minY + box.maxY - point[1]];
            });
            if (!applySectionPoints(selected, points)) { return; }
            renderAll();
            markDirty();
            setStatus(horizontal ? "Mirrored section left to right." : "Mirrored section top to bottom.");
        });
    });

    function startRotate(e, s) {
        if (!editing || draft) { return; }
        e.preventDefault();
        e.stopPropagation();
        var rotate = sectionRotation(s);
        var box = bbox(s.points);
        var cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
        var start = toCanvas(e);
        var initialAngle = Math.atan2(start.y - cy, start.x - cx);
        function move(ev) {
            var p = toCanvas(ev);
            rotate(Math.atan2(p.y - cy, p.x - cx) - initialAngle);
        }
        function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            markDirty();
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    }

    // --- Public bridge --------------------------------------------------------
    window.HallSectionEditor = {
        // The payload sent to PUT /halls/{id}/seats as `sections`.
        hasOverlappingSections: function (items) {
            var candidates = items ? items.map(function (section) {
                return { points: section.points.map(function (point) { return [point.x, point.y]; }) };
            }) : sections;
            return sectionsOverlap(candidates, []);
        },
        serialize: function () {
            return sections.map(function (s) {
                return {
                    id: s.id,
                    clientKey: s.key,
                    name: s.name,
                    bookingMode: s.mode,
                    currency: s.currency || null,
                    capacity: s.mode === "GENERAL_ADMISSION" ? s.capacity : null,
                    serviceFeePerTicket: s.serviceFeePerTicket,
                    shapeKind: s.shapeKind || "POLYGON",
                    points: s.points.map(function (p) { return { x: p[0], y: p[1] }; }),
                    color: s.color || null
                };
            });
        },
        replaceAll: function (items, options) {
            var preserveIds = !!(options && options.preserveIds);
            var existingIds = Object.create(null);
            sections.forEach(function (s) {
                if (s.id != null) { existingIds[s.id] = true; }
            });
            var imported = (items || []).map(function (item, index) {
                var id = preserveIds && item.id != null && existingIds[item.id]
                    ? item.id
                    : null;
                return {
                    key: id != null ? "section:" + id : "sdraft:" + nextDraftKey++,
                    id: id,
                    name: item.name,
                    mode: item.bookingMode === "GENERAL_ADMISSION"
                        ? "GENERAL_ADMISSION"
                        : "SEATED",
                    currency: item.currency || "JOD",
                    capacity: item.capacity != null ? Number(item.capacity) : null,
                    serviceFeePerTicket: item.serviceFeePerTicket,
                    color: item.color || PALETTE[index % PALETTE.length],
                    shapeKind: item.shapeKind || "POLYGON",
                    points: (item.points || []).map(function (point) {
                        return [num(Array.isArray(point) ? point[0] : point.x),
                                num(Array.isArray(point) ? point[1] : point.y)];
                    })
                };
            });
            sections = imported;
            selection = [];
            selected = null;
            soloKey = null;
            clipboard = null;
            groupList = [];
            nextGroupId = 1;
            ensureSectionsFit(sections);
            renderAll();
            refreshInspector();
            renderOutliner();
            refreshCommandState();
            notify();
            if (!(options && options.silent)) { markDirty(); }
            return new Map(imported.map(function (section, index) { return [items[index].clientKey, section.key]; }));
        },
        translateSectionsX: function (dx) {
            sections.forEach(function (section) {
                section.points = section.points.map(function (point) {
                    return [point[0] + dx, point[1]];
                });
            });
        },
        getBounds: function () {
            if (!sections.some(function (section) { return section.points.length; })) { return null; }
            var box = selectionBounds(sections, [], []);
            return {
                left: box.minX,
                top: box.minY,
                right: box.maxX,
                bottom: box.maxY
            };
        },
        onCanvasResize: function () {
            renderAll();
        },
        // Lightweight view for the 2D/3D bridge snapshot.
        getSections: function () {
            return sections.map(function (s) {
                return {
                    key: s.key, id: s.id, name: s.name, mode: s.mode,
                    currency: s.currency, capacity: s.capacity,
                    color: s.color, points: s.points.map(function (p) { return { x: p[0], y: p[1] }; })
                };
            });
        },
        // Snapshot of the currently-selected section (the primary, if several are selected), or
        // null when none. Used by hall-focus-mode.js to drive the right-side inspector.
        getSelectedSection: function () {
            if (!selected) { return null; }
            var bb = bbox(selected.points);
            return {
                key: selected.key,
                id: selected.id,
                name: selected.name,
                mode: selected.mode,
                currency: selected.currency || null,
                capacity: selected.mode === "GENERAL_ADMISSION" ? selected.capacity : null,
                color: selected.color || null,
                bbox: { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY },
                // Deep-cloned polygon vertices so the Section Edit view can clamp seats and
                // generate seat grids that respect the section's actual shape (not just bbox).
                points: selected.points.map(function (p) { return { x: p[0], y: p[1] }; })
            };
        },
        // Lets the seat editor drop the section selection when a seat is plainly clicked, so the
        // two overlays are never both showing a selection.
        clearSelection: function () {
            if (!selection.length) { return; }
            soloKey = null;
            selection = [];
            selected = null;
            renderAll();
            refreshInspector();
            renderOutliner();
            notify();
        },
        // After a save, refresh ids by matching section name.
        applyServerIds: function (serverSections) {
            var idByName = {};
            (serverSections || []).forEach(function (s) { idByName[s.name] = s.id; });
            sections.forEach(function (s) {
                if (idByName[s.name] != null) {
                    var oldKey = s.key;
                    s.id = idByName[s.name];
                    s.key = "section:" + s.id;
                    if (oldKey !== s.key) { Groups.rekey("section", oldKey, s.key); }
                }
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
    function bbox(pts) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        pts.forEach(function (p) {
            if (p[0] < minX) { minX = p[0]; }
            if (p[1] < minY) { minY = p[1]; }
            if (p[0] > maxX) { maxX = p[0]; }
            if (p[1] > maxY) { maxY = p[1]; }
        });
        return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
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
    function syncSeatSections() {
        if (!window.HallSeatEditor || !window.HallSeatEditor.applySeatSectionPatch) { return false; }
        var state;
        try { state = window.HallSeatEditor.getState(); } catch (e) { return false; }
        var seated = sections.filter(function (section) { return section.mode === "SEATED"; });
        var byKey = new Map(seated.map(function (section) { return [section.key, section]; }));
        var patches = [];
        state.seats.forEach(function (seat) {
            var match = byKey.get(seat.sectionKey);
            // Layout imports and pasted blocks can arrive without a section key.
            if (seat.sectionKey == null) {
                match = seated.find(function (section) {
                    return containsPoint(section.points, seat.x + seat.w / 2, seat.y + seat.h / 2);
                });
                if (!match) { return; }
            }
            var key = match ? match.key : "";
            var name = match ? match.name : "";
            if (seat.sectionKey !== key || seat.section !== name) {
                patches.push({ key: seat.key, section: name, sectionKey: key });
            }
        });
        return patches.length
            ? window.HallSeatEditor.applySeatSectionPatch(patches, { transient: true })
            : false;
    }
    function containsPoint(points, x, y) {
        var inside = false;
        for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
            var xi = points[i][0], yi = points[i][1];
            var xj = points[j][0], yj = points[j][1];
            var intersect = ((yi > y) !== (yj > y))
                && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) { inside = !inside; }
        }
        return inside;
    }
    function markDirty() {
        ensureSectionsFit(sections);
        syncSeatSections();
        window.HallSeatEditor.validateSeatPlacements();
        var st = document.getElementById("layoutStatus");
        if (st) { st.textContent = "Unsaved changes"; st.className = "layout-status dirty"; }
        notify();
    }
    function notify() {
        window.dispatchEvent(new CustomEvent("hall-sections-change"));
    }

    // Bind to the seat editor's edit state last: the subscription fires immediately, and setMode
    // touches Tabs/Presets/the outliner, all of which must already exist. (A page opened with
    // ?edit=true has the seat editor editing before this module even loads.)
    if (window.HallSeatEditor) { bindSeatMode(); }
    else { window.addEventListener("hall-seat-editor-ready", bindSeatMode, { once: true }); }
})();
