/*
 * Dynamic seat-layout renderer + editor for the admin app.
 *
 * View mode: draws each seat at its stored pixel coordinates, size and rotation.
 * Edit mode:
 *   - drag seats to reposition (multiple selected seats move together);
 *   - shift-click to add/remove seats from the selection;
 *   - drag on empty canvas space to marquee-select seats;
 *   - generate collision-checked rectangular seat blocks;
 *   - assign section, rotation and size;
 *   - add/remove rows, columns and individual seats;
 *   - Save POSTs the full desired seat set to /halls/{id}/seats, which the backend reconciles
 *     (creating new seats, updating existing ones, deleting those left out).
 */
(function () {
    "use strict";

    var canvas = document.getElementById("seatCanvas");
    if (!canvas) {
        return;
    }

    var GAP_X = 58, GAP_Y = 52, DEF_W = 42, DEF_H = 38, START_X = 70, START_Y = 150;
    var LAYOUT_MARGIN = 24, STAGE_CLEAR_BOTTOM = 118, PLACEMENT_CLEARANCE = 6;
    var MIN_SEAT_SIZE = 4, MAX_SEAT_SIZE = 120;
    var MAX_BULK_SEATS = 500, CANVAS_GROW_STEP = 120;

    var W = int(canvas.dataset.w, 900);
    var H = int(canvas.dataset.h, 600);
    var hallId = int(canvas.dataset.hallId, null);
    var seatsUrl = canvas.dataset.seatsUrl;

    canvas.style.width = W + "px";
    canvas.style.height = H + "px";

    var chips = Array.prototype.slice.call(canvas.querySelectorAll(".seat-chip"));

    var btnEdit = document.getElementById("btnEdit");
    var btnSave = document.getElementById("btnSave");
    var btnCancel = document.getElementById("btnCancel");
    var btnExportLayout = document.getElementById("btnExportLayout");
    var btnImportLayout = document.getElementById("btnImportLayout");
    var layoutImportFile = document.getElementById("layoutImportFile");
    var statusEl = document.getElementById("layoutStatus");
    var hintEl = document.getElementById("layoutHint");
    var tools = document.getElementById("layoutTools");
    var bulkGridTools = document.getElementById("bulkGridTools");
    var canvasSizeTools = document.getElementById("canvasSizeTools");
    var arrangeTools = document.getElementById("arrangeTools");
    var gridColumns = document.getElementById("gridColumns");
    var gridRows = document.getElementById("gridRows");
    var gridGapX = document.getElementById("gridGapX");
    var gridGapY = document.getElementById("gridGapY");
    var gridFitSummary = document.getElementById("gridFitSummary");
    var btnAddGrid = document.getElementById("btnAddGrid");
    var selectionGapX = document.getElementById("selectionGapX");
    var selectionGapY = document.getElementById("selectionGapY");
    var selectionSpacingSummary = document.getElementById("selectionSpacingSummary");
    var spacingAnchorButtons = Array.prototype.slice.call(
        document.querySelectorAll(".spacing-anchor button")
    );
    var canvasWidthInput = document.getElementById("canvasWidth");
    var canvasHeightInput = document.getElementById("canvasHeight");
    var btnApplyCanvasSize = document.getElementById("btnApplyCanvasSize");
    var btnFitCanvas = document.getElementById("btnFitCanvas");
    var canvasSizeSummary = document.getElementById("canvasSizeSummary");
    var hall3dHost = document.getElementById("hall3dCanvas");
    var inspector = document.getElementById("inspector");
    var selLabel = document.getElementById("selLabel");
    var inSection = document.getElementById("inSection");
    var inRotation = document.getElementById("inRotation");
    var rotVal = document.getElementById("rotVal");
    var inWidth = document.getElementById("inWidth");
    var inHeight = document.getElementById("inHeight");

    var editing = false;
    var selection = [];
    var primary = null;
    var structureChanged = false; // seats added/removed -> Cancel must reload
    var bridgeListeners = [];
    var nextDraftKey = 1;
    var marquee = null;
    var marqueeFrame = null;
    var spacingAnchor = "top-left";

    // --- Initialise seat state from data attributes and render ---------------
    chips.forEach(function (el) {
        el._st = {
            id: hasVal(el.dataset.id) ? int(el.dataset.id, null) : null,
            label: el.dataset.label || el.textContent,
            rowLabel: el.dataset.rowlabel || "",
            r: int(el.dataset.row, 1),
            c: int(el.dataset.col, 1),
            x: int(el.dataset.x, START_X),
            y: int(el.dataset.y, START_Y),
            w: clamp(int(el.dataset.w, DEF_W), MIN_SEAT_SIZE, MAX_SEAT_SIZE),
            h: clamp(int(el.dataset.h, DEF_H), MIN_SEAT_SIZE, MAX_SEAT_SIZE),
            rot: clamp(int(el.dataset.rot, 0), -180, 180),
            section: el.dataset.section || "",
            sectionKey: el.dataset.sectionId ? "section:" + el.dataset.sectionId : ""
        };
        ensureSeatKey(el._st);
        if (!el._st.rowLabel) { el._st.rowLabel = letter(el._st.r); }
        clampPosition(el);
        render(el);
        el.addEventListener("pointerdown", onSeatPointerDown);
    });

    ensureCanvasFits(chips.map(function (el) { return el._st; }));
    var savedState = chips.map(function (el) { return copy(el._st); });
    var savedCanvas = { width: W, height: H };

    if (new URLSearchParams(window.location.search).get("edit") === "true") {
        setEditing(true);
        statusEl.textContent = "New hall — arrange seats, add or remove seats, then Save.";
        canvas.scrollIntoView({ block: "center" });
        if (window.history && window.history.replaceState) {
            window.history.replaceState({}, "", window.location.pathname);
        }
    }

    function render(el) {
        var s = el._st;
        el.style.left = s.x + "px";
        el.style.top = s.y + "px";
        el.style.width = s.w + "px";
        el.style.height = s.h + "px";
        el.style.transform = "rotate(" + s.rot + "deg)";
        el.classList.toggle("selected", isSelected(el));
        el.textContent = s.label;
        el.title = s.label;
    }

    function clampPosition(el) {
        var s = el._st;
        var b = window.SeatBoundsOverride;
        if (b) {
            var x = Math.max(Math.ceil(b.left), Math.min(Math.floor(b.right - s.w), s.x));
            var y = Math.max(Math.ceil(b.top), Math.min(Math.floor(b.bottom - s.h), s.y));
            // Pull legacy out-of-bounds seats inward when opening the section.
            if (!seatFitsSection(s, x, y, b) && b.centroid) {
                var dx = b.centroid.x - (x + s.w / 2);
                var dy = b.centroid.y - (y + s.h / 2);
                var steps = Math.ceil(Math.hypot(dx, dy));
                for (var i = 1; i <= steps; i++) {
                    var nextX = Math.round(x + dx * i / steps);
                    var nextY = Math.round(y + dy * i / steps);
                    if (seatFitsSection(s, nextX, nextY, b)) {
                        x = nextX;
                        y = nextY;
                        break;
                    }
                }
            }
            if (seatFitsSection(s, x, y, b)) {
                s.x = x;
                s.y = y;
            }
        } else {
            s.x = Math.max(0, s.x);
            s.y = Math.max(0, s.y);
        }
    }

    // Ray-casting point-in-polygon used by clampPosition when a Section Edit view publishes
    // a polygon on SeatBoundsOverride. Same algorithm as hall-3d.js's pointInPolygon.
    function pointInPoly(points, x, y) {
        var inside = false;
        for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
            var a = points[i], b = points[j];
            var crosses = ((a.y > y) !== (b.y > y))
                && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || 1e-9) + a.x;
            if (crosses) { inside = !inside; }
        }
        return inside;
    }

    function seatFitsSection(seat, x, y, bounds) {
        var polygon = bounds.polygon;
        if (x < 0 || y < 0 || !polygon || polygon.length < 3) { return false; }

        var hw = seat.w / 2, hh = seat.h / 2;
        var cx = x + hw, cy = y + hh;
        var angle = (seat.rot || 0) * Math.PI / 180;
        var cos = Math.cos(angle), sin = Math.sin(angle);
        for (var horizontal = -1; horizontal <= 1; horizontal += 2) {
            for (var vertical = -1; vertical <= 1; vertical += 2) {
                var u = horizontal * hw, v = vertical * hh;
                var px = cx + u * cos - v * sin, py = cy + u * sin + v * cos;
                if (!pointInPoly(polygon, px, py) && !polygon.some(function (a, i) {
                    var b = polygon[(i + 1) % polygon.length];
                    var epsilon = 1e-8;
                    return px >= Math.min(a.x, b.x) - epsilon && px <= Math.max(a.x, b.x) + epsilon
                        && py >= Math.min(a.y, b.y) - epsilon && py <= Math.max(a.y, b.y) + epsilon
                        && Math.abs((px - a.x) * (b.y - a.y) - (py - a.y) * (b.x - a.x)) < epsilon;
                })) {
                    return false;
                }
            }
        }

        // Test boundary edges in the seat's local coordinates. A concave boundary
        // can cut through a seat even when all four corners are inside.
        function local(point) {
            var dx = point.x - cx, dy = point.y - cy;
            return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
        }
        var a = local(polygon[polygon.length - 1]);
        for (var i = 0; i < polygon.length; i++) {
            var b = local(polygon[i]);
            if (Math.max(a.x, b.x) > -hw && Math.min(a.x, b.x) < hw
                && Math.max(a.y, b.y) > -hh && Math.min(a.y, b.y) < hh) {
                var dx = b.x - a.x, dy = b.y - a.y;
                var tx1 = dx ? (-hw - a.x) / dx : -Infinity;
                var tx2 = dx ? (hw - a.x) / dx : Infinity;
                var ty1 = dy ? (-hh - a.y) / dy : -Infinity;
                var ty2 = dy ? (hh - a.y) / dy : Infinity;
                if (Math.max(0, Math.min(tx1, tx2), Math.min(ty1, ty2))
                    < Math.min(1, Math.max(tx1, tx2), Math.max(ty1, ty2))) {
                    return false;
                }
            }
            a = b;
        }
        return true;
    }

    // --- Selection -----------------------------------------------------------
    function isSelected(el) { return selection.indexOf(el) !== -1; }
    function setSelection(list) {
        selection = list;
        primary = list.length ? list[list.length - 1] : null;
        chips.forEach(render);
        refreshInspector();
        notifyBridge("selection");
    }
    function setSelectionIfChanged(list) {
        if (list.length === selection.length && list.every(function (el) {
            return selection.indexOf(el) !== -1;
        })) {
            return;
        }
        setSelection(list);
    }
    function toggleInSelection(el) {
        var i = selection.indexOf(el);
        if (i === -1) { selection.push(el); primary = el; }
        else { selection.splice(i, 1); primary = selection.length ? selection[selection.length - 1] : null; }
        chips.forEach(render);
        refreshInspector();
        notifyBridge("selection");
    }
    function refreshInspector() {
        refreshGridCapacity();
        refreshArrangeTools();
        if (!selection.length) { inspector.classList.add("hidden"); return; }
        inspector.classList.remove("hidden");
        selLabel.textContent = selection.length === 1
            ? primary._st.label
            : selection.length + " seats selected";
        var ref = primary || selection[0];
        inSection.value = ref._st.section;
        inRotation.value = ref._st.rot;
        rotVal.textContent = ref._st.rot;
        inWidth.value = ref._st.w;
        inHeight.value = ref._st.h;
    }
    function applyToSelection(fn) {
        selection.forEach(function (el) { fn(el); render(el); });
        ensureCanvasFits(selection.map(function (el) { return el._st; }));
        markDirty();
    }

    // --- Dragging (whole selection) -----------------------------------------
    function onSeatPointerDown(e) {
        if (!editing) { return; }
        e.preventDefault();
        clearTableSelection();
        var el = e.currentTarget;

        if (e.shiftKey) { toggleInSelection(el); return; }
        // A plain click on a seat is exclusive: drop any section selection so the two overlays never
        // look simultaneously "selected". Ctrl-click keeps sections selected so a mixed set of
        // seats + sections can be built up and then grouped with Ctrl+G.
        if (!e.ctrlKey && !e.metaKey && window.HallSectionEditor
                && window.HallSectionEditor.clearSelection) {
            window.HallSectionEditor.clearSelection();
        }
        if (!isSelected(el)) { setSelection([el]); }
        else { primary = el; refreshInspector(); }

        if (!window.SeatBoundsOverride) { return; }

        // If this seat belongs to a cross-object group, expand the selection to every grouped seat
        // and capture the group's section/table baseline so they all move together (bidirectional).
        // Alt+click drills into the group so this one seat can be moved/edited on its own.
        var groupBase = null;
        var last = { dx: 0, dy: 0 };
        var sectionBounds = window.SeatBoundsOverride;
        if (!sectionBounds && window.HallGroups && !e.altKey) {
            var gkey = ensureSeatKey(el._st);
            var g = window.HallGroups.groupOf("seat", gkey);
            if (g) {
                var union = selection.slice();
                g.members.seats.forEach(function (k) {
                    var se = findByKey(k);
                    if (se && union.indexOf(se) === -1) { union.push(se); }
                });
                if (union.length !== selection.length) { setSelection(union); }
            }
            // Always ask for companions, group or not: anything co-selected (sections, tables)
            // travels with this drag, because being selected together is intent enough.
            groupBase = window.HallGroups.memberBaseline("seat", gkey);
        }

        var rect = canvas.getBoundingClientRect();
        var scaleX = rect.width / W || 1;
        var scaleY = rect.height / H || 1;
        var startX = e.clientX, startY = e.clientY;
        var moving = selection.map(function (s) { return { el: s, ox: s._st.x, oy: s._st.y }; });

        el.setPointerCapture(e.pointerId);
        function move(ev) {
            var dx = (ev.clientX - startX) / scaleX;
            var dy = (ev.clientY - startY) / scaleY;
            if (sectionBounds) {
                dx = Math.round(dx);
                dy = Math.round(dy);
                function fitsAt(x, y) {
                    return moving.every(function (m) {
                        return seatFitsSection(m.el._st, m.ox + x, m.oy + y, sectionBounds);
                    });
                }
                if (!fitsAt(dx, dy)) {
                    // Approach the edge from the last accepted position using a shared
                    // offset so selected seats keep their spacing.
                    var low = 0, high = 1;
                    for (var i = 0; i < 12; i++) {
                        var fraction = (low + high) / 2;
                        var x = Math.round(last.dx + (dx - last.dx) * fraction);
                        var y = Math.round(last.dy + (dy - last.dy) * fraction);
                        if (fitsAt(x, y)) { low = fraction; } else { high = fraction; }
                    }
                    dx = Math.round(last.dx + (dx - last.dx) * low);
                    dy = Math.round(last.dy + (dy - last.dy) * low);
                    if (!fitsAt(dx, dy)) { return; }
                }
            }
            last.dx = dx; last.dy = dy;
            moving.forEach(function (m) {
                m.el._st.x = Math.round(m.ox + dx);
                m.el._st.y = Math.round(m.oy + dy);
                if (!sectionBounds) { clampPosition(m.el); }
                render(m.el);
            });
            ensureCanvasFits(moving.map(function (m) { return m.el._st; }));
            if (groupBase) { window.HallGroups.applyMemberBaseline(groupBase, dx, dy, true); }
        }
        function up() {
            el.releasePointerCapture(e.pointerId);
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            if (groupBase) { window.HallGroups.applyMemberBaseline(groupBase, last.dx, last.dy, false); }
            markDirty();
        }
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
    }

    canvas.addEventListener("pointerdown", onCanvasPointerDown);

    function onCanvasPointerDown(e) {
        if (!editing || e.target !== canvas || e.button !== 0 || e.isPrimary === false) { return; }
        e.preventDefault();
        clearTableSelection();

        var start = canvasPoint(e);
        var overlay = document.createElement("div");
        overlay.className = "selection-marquee";
        overlay.setAttribute("aria-hidden", "true");
        canvas.appendChild(overlay);

        marquee = {
            pointerId: e.pointerId,
            start: start,
            current: start,
            base: selection.slice(),
            additive: e.shiftKey || e.ctrlKey || e.metaKey,
            subtractive: e.altKey,
            moved: false,
            overlay: overlay
        };

        canvas.setPointerCapture(e.pointerId);
        canvas.addEventListener("pointermove", onMarqueeMove);
        canvas.addEventListener("pointerup", onMarqueeUp);
        canvas.addEventListener("pointercancel", onMarqueeCancel);
    }

    function onMarqueeMove(e) {
        if (!marquee || e.pointerId !== marquee.pointerId) { return; }
        e.preventDefault();
        marquee.current = canvasPoint(e);
        marquee.moved = marquee.moved ||
            Math.abs(marquee.current.x - marquee.start.x) >= 3 ||
            Math.abs(marquee.current.y - marquee.start.y) >= 3;
        if (!marqueeFrame) {
            marqueeFrame = window.requestAnimationFrame(function () {
                marqueeFrame = null;
                updateMarqueeSelection();
            });
        }
    }

    function onMarqueeUp(e) {
        if (!marquee || e.pointerId !== marquee.pointerId) { return; }
        marquee.current = canvasPoint(e);
        if (marqueeFrame) {
            window.cancelAnimationFrame(marqueeFrame);
            marqueeFrame = null;
        }
        if (marquee.moved) {
            updateMarqueeSelection();
        } else if (!marquee.additive && !marquee.subtractive) {
            setSelection([]);
        }
        cleanupMarquee();
    }

    function onMarqueeCancel(e) {
        if (!marquee || e.pointerId !== marquee.pointerId) { return; }
        setSelectionIfChanged(marquee.base);
        cleanupMarquee();
    }

    function cleanupMarquee() {
        if (!marquee) { return; }
        if (marqueeFrame) {
            window.cancelAnimationFrame(marqueeFrame);
            marqueeFrame = null;
        }
        if (canvas.hasPointerCapture(marquee.pointerId)) {
            canvas.releasePointerCapture(marquee.pointerId);
        }
        marquee.overlay.remove();
        marquee = null;
        canvas.removeEventListener("pointermove", onMarqueeMove);
        canvas.removeEventListener("pointerup", onMarqueeUp);
        canvas.removeEventListener("pointercancel", onMarqueeCancel);
    }

    function updateMarqueeSelection() {
        if (!marquee || !marquee.moved) { return; }
        var box = normalizedRect(marquee.start, marquee.current);
        marquee.overlay.style.left = box.left + "px";
        marquee.overlay.style.top = box.top + "px";
        marquee.overlay.style.width = box.width + "px";
        marquee.overlay.style.height = box.height + "px";

        var hits = chips.filter(function (el) {
            return rectsIntersect(box, stateBounds(el._st));
        });
        var next;
        if (marquee.subtractive) {
            next = marquee.base.filter(function (el) { return hits.indexOf(el) === -1; });
        } else if (marquee.additive) {
            next = marquee.base.slice();
            hits.forEach(function (el) {
                if (next.indexOf(el) === -1) { next.push(el); }
            });
        } else {
            next = hits;
        }
        setSelectionIfChanged(next);
    }

    function canvasPoint(e) {
        var rect = canvas.getBoundingClientRect();
        return {
            x: clamp((e.clientX - rect.left) * W / Math.max(1, rect.width), 0, W),
            y: clamp((e.clientY - rect.top) * H / Math.max(1, rect.height), 0, H)
        };
    }

    function normalizedRect(a, b) {
        var left = Math.min(a.x, b.x);
        var top = Math.min(a.y, b.y);
        var right = Math.max(a.x, b.x);
        var bottom = Math.max(a.y, b.y);
        return {
            left: left,
            top: top,
            right: right,
            bottom: bottom,
            width: right - left,
            height: bottom - top
        };
    }

    function stateBounds(s) {
        var radians = (s.rot || 0) * Math.PI / 180;
        var halfWidth = s.w / 2;
        var halfHeight = s.h / 2;
        var extentX = Math.abs(Math.cos(radians)) * halfWidth +
            Math.abs(Math.sin(radians)) * halfHeight;
        var extentY = Math.abs(Math.sin(radians)) * halfWidth +
            Math.abs(Math.cos(radians)) * halfHeight;
        var centerX = s.x + halfWidth;
        var centerY = s.y + halfHeight;
        return {
            left: centerX - extentX,
            top: centerY - extentY,
            right: centerX + extentX,
            bottom: centerY + extentY,
            width: extentX * 2,
            height: extentY * 2
        };
    }

    function rectsIntersect(a, b) {
        return a.left <= b.right && a.right >= b.left &&
            a.top <= b.bottom && a.bottom >= b.top;
    }

    function inflateRect(rect, amount) {
        return {
            left: rect.left - amount,
            top: rect.top - amount,
            right: rect.right + amount,
            bottom: rect.bottom + amount,
            width: rect.width + amount * 2,
            height: rect.height + amount * 2
        };
    }

    // --- Inspector controls --------------------------------------------------
    inSection.addEventListener("change", function () {
        var name = inSection.value.trim();
        var editor = window.HallSectionEditor;
        var section = name && editor && editor.getSections().find(function (candidate) {
            return candidate.mode === "SEATED" && candidate.name.toLowerCase() === name.toLowerCase();
        });
        if (name && !section) {
            refreshInspector();
            statusEl.textContent = "Enter the name of a seated section.";
            return;
        }
        applyToSelection(function (el) {
            el._st.section = section ? section.name : "";
            el._st.sectionKey = section ? section.key : "";
        });
    });
    inRotation.addEventListener("input", function () {
        var v = clamp(int(inRotation.value, 0), -180, 180);
        rotVal.textContent = v;
        applyToSelection(function (el) { el._st.rot = v; });
    });
    inWidth.addEventListener("change", function () {
        var v = clamp(int(inWidth.value, DEF_W), MIN_SEAT_SIZE, MAX_SEAT_SIZE);
        inWidth.value = v;
        applyToSelection(function (el) { el._st.w = v; clampPosition(el); });
    });
    inHeight.addEventListener("change", function () {
        var v = clamp(int(inHeight.value, DEF_H), MIN_SEAT_SIZE, MAX_SEAT_SIZE);
        inHeight.value = v;
        applyToSelection(function (el) { el._st.h = v; clampPosition(el); });
    });

    // --- Add / remove seats, rows, columns -----------------------------------
    function maxRow() { return chips.reduce(function (m, el) { return Math.max(m, el._st.r); }, 0); }
    function maxCol() { return chips.reduce(function (m, el) { return Math.max(m, el._st.c); }, 0); }
    function rowsPresent() {
        var set = {};
        chips.forEach(function (el) { set[el._st.r] = 1; });
        return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    }
    function rowLabelFor(r) {
        for (var i = 0; i < chips.length; i++) { if (chips[i]._st.r === r) { return chips[i]._st.rowLabel; } }
        return letter(r);
    }
    function maxColInRow(r) {
        return chips.reduce(function (m, el) { return el._st.r === r ? Math.max(m, el._st.c) : m; }, 0);
    }

    function createChip(st, parent) {
        var el = document.createElement("span");
        ensureSeatKey(st);
        if (window.SeatBoundsOverride && st.id == null) {
            st.sectionKey = window.SeatBoundsOverride.sectionKey;
        }
        el._st = st;
        el.classList.add("seat-chip");
        el.addEventListener("pointerdown", onSeatPointerDown);
        (parent || canvas).appendChild(el);
        chips.push(el);
        clampPosition(el);
        render(el);
        return el;
    }

    function createChips(states) {
        var fragment = document.createDocumentFragment();
        var created = states.map(function (state) { return createChip(state, fragment); });
        canvas.appendChild(fragment);
        return created;
    }

    function afterStructureChange(newlySelected) {
        structureChanged = true;
        markDirty();
        setSelection(newlySelected || []);
    }

    function seatTemplate() {
        var source = primary ? primary._st : null;
        return {
            w: source ? source.w : DEF_W,
            h: source ? source.h : DEF_H,
            section: source ? source.section : "",
            sectionKey: source ? source.sectionKey || undefined : undefined
        };
    }

    function readGap(input, fallback) {
        return clamp(int(input ? input.value : fallback, fallback), 0, 160);
    }

    function readGridSpec(normalize) {
        var template = seatTemplate();
        var spec = {
            columns: clamp(int(gridColumns ? gridColumns.value : 8, 8), 1, 50),
            rows: clamp(int(gridRows ? gridRows.value : 5, 5), 1, 50),
            gapX: readGap(gridGapX, GAP_X - DEF_W),
            gapY: readGap(gridGapY, GAP_Y - DEF_H),
            seatWidth: template.w,
            seatHeight: template.h,
            section: template.section,
            sectionKey: template.sectionKey
        };
        if (normalize) {
            if (gridColumns) { gridColumns.value = spec.columns; }
            if (gridRows) { gridRows.value = spec.rows; }
            if (gridGapX) { gridGapX.value = spec.gapX; }
            if (gridGapY) { gridGapY.value = spec.gapY; }
        }
        return spec;
    }

    function usablePlacementBounds() {
        return {
            left: LAYOUT_MARGIN,
            top: Math.min(H - LAYOUT_MARGIN, Math.max(LAYOUT_MARGIN, STAGE_CLEAR_BOTTOM)),
            right: Math.max(LAYOUT_MARGIN, W - LAYOUT_MARGIN),
            bottom: Math.max(LAYOUT_MARGIN, H - LAYOUT_MARGIN)
        };
    }

    function gridBlockSize(spec) {
        return {
            width: spec.columns * spec.seatWidth + (spec.columns - 1) * spec.gapX,
            height: spec.rows * spec.seatHeight + (spec.rows - 1) * spec.gapY
        };
    }

    function setCanvasSize(width, height) {
        W = Math.max(320, Math.round(width));
        H = Math.max(240, Math.round(height));
        canvas.dataset.w = String(W);
        canvas.dataset.h = String(H);
        canvas.style.width = W + "px";
        canvas.style.height = H + "px";
        if (hall3dHost) {
            hall3dHost.dataset.w = String(W);
            hall3dHost.dataset.h = String(H);
        }
        if (canvasWidthInput) { canvasWidthInput.value = W; }
        if (canvasHeightInput) { canvasHeightInput.value = H; }
        if (canvasSizeSummary) { canvasSizeSummary.textContent = W + " x " + H + " px"; }
        if (window.HallSectionEditor && window.HallSectionEditor.onCanvasResize) {
            window.HallSectionEditor.onCanvasResize();
        }
        refreshGridCapacity();
    }

    function contentBounds() {
        var left = Infinity;
        var right = -Infinity;
        var bottom = STAGE_CLEAR_BOTTOM;
        chips.forEach(function (el) {
            var bounds = stateBounds(el._st);
            left = Math.min(left, bounds.left);
            right = Math.max(right, bounds.right);
            bottom = Math.max(bottom, bounds.bottom);
        });
        (tableEls || []).forEach(function (el) {
            var t = el._tt;
            var bounds = stateBounds({ x: t.x, y: t.y, w: t.w, h: t.d, rot: t.rot });
            left = Math.min(left, bounds.left);
            right = Math.max(right, bounds.right);
            bottom = Math.max(bottom, bounds.bottom);
        });
        if (window.HallSectionEditor && window.HallSectionEditor.getBounds) {
            var sectionBounds = window.HallSectionEditor.getBounds();
            if (sectionBounds) {
                left = Math.min(left, sectionBounds.left);
                right = Math.max(right, sectionBounds.right);
                bottom = Math.max(bottom, sectionBounds.bottom);
            }
        }
        return { left: isFinite(left) ? left : 0, right: isFinite(right) ? right : 0, bottom: bottom };
    }

    function minimumCanvasSize() {
        var bounds = contentBounds();
        return {
            width: Math.max(320, Math.ceil(bounds.right + LAYOUT_MARGIN)),
            height: Math.max(240, Math.ceil(bounds.bottom + LAYOUT_MARGIN))
        };
    }

    function ensureLayoutBounds(bounds) {
        if (!bounds) { return false; }
        var nextWidth = W;
        var nextHeight = H;
        if ((bounds.right || 0) + LAYOUT_MARGIN > W) {
            nextWidth = roundUp((bounds.right || 0) + LAYOUT_MARGIN, CANVAS_GROW_STEP);
        }
        if ((bounds.bottom || 0) + LAYOUT_MARGIN > H) {
            nextHeight = roundUp((bounds.bottom || 0) + LAYOUT_MARGIN, CANVAS_GROW_STEP);
        }
        if (nextWidth === W && nextHeight === H) { return false; }
        setCanvasSize(nextWidth, nextHeight);
        return true;
    }

    function ensureCanvasFits(states) {
        if (!states || !states.length) { return false; }
        var requiredRight = states.reduce(function (right, state) {
            return Math.max(right, stateBounds(state).right);
        }, 0);
        var requiredBottom = states.reduce(function (bottom, state) {
            return Math.max(bottom, stateBounds(state).bottom);
        }, 0);
        var nextWidth = W;
        var nextHeight = H;

        if (requiredRight + LAYOUT_MARGIN > W) {
            nextWidth = roundUp(requiredRight + LAYOUT_MARGIN, CANVAS_GROW_STEP);
        }
        if (requiredBottom + LAYOUT_MARGIN > H) {
            nextHeight = roundUp(requiredBottom + LAYOUT_MARGIN, CANVAS_GROW_STEP);
        }
        if (nextWidth === W && nextHeight === H) { return false; }
        setCanvasSize(nextWidth, nextHeight);
        return true;
    }

    function applyCanvasSize() {
        if (!editing) { return; }
        var requestedWidth = clamp(int(canvasWidthInput && canvasWidthInput.value, W), 320, 12000);
        var requestedHeight = clamp(int(canvasHeightInput && canvasHeightInput.value, H), 240, 12000);
        var minimum = minimumCanvasSize();
        var nextWidth = Math.max(requestedWidth, minimum.width);
        var nextHeight = Math.max(requestedHeight, minimum.height);
        setCanvasSize(nextWidth, nextHeight);
        markDirty();
        if (nextWidth !== requestedWidth || nextHeight !== requestedHeight) {
            statusEl.textContent = "Layout kept large enough so no seats, tables, or sections are hidden.";
            statusEl.className = "layout-status dirty";
        }
    }

    function translateContentsX(pixels) {
        chips.forEach(function (el) {
            el._st.x += pixels;
            render(el);
        });
        tableEls.forEach(function (el) {
            el._tt.x += pixels;
            renderTable(el);
        });
    }

    function fitCanvasToContents() {
        if (!editing) { return; }
        var bounds = contentBounds();
        var width = Math.max(320, Math.ceil(bounds.right - bounds.left + 2 * LAYOUT_MARGIN));
        var dx = Math.round(width / 2 - (bounds.left + bounds.right) / 2);
        if (dx) {
            translateContentsX(dx);
            if (window.HallSectionEditor) { window.HallSectionEditor.translateSectionsX(dx); }
        }
        setCanvasSize(width, Math.max(240, Math.ceil(bounds.bottom + LAYOUT_MARGIN)));
        markDirty();
    }

    setCanvasSize(W, H);
    if (btnApplyCanvasSize) { btnApplyCanvasSize.addEventListener("click", applyCanvasSize); }
    if (btnFitCanvas) { btnFitCanvas.addEventListener("click", fitCanvasToContents); }

    function refreshGridCapacity() {
        if (!gridFitSummary) { return; }
        var spec = readGridSpec(false);
        var block = gridBlockSize(spec);
        gridFitSummary.textContent = "Block " + Math.round(block.width) + " x " +
            Math.round(block.height) + " px | Canvas " + W + " x " + H +
            " px | Auto grows";
    }

    function stageReservedRect() {
        var stageWidth = Math.min(W * 0.6, 520);
        return {
            left: (W - stageWidth) / 2 - PLACEMENT_CLEARANCE,
            top: 40 - PLACEMENT_CLEARANCE,
            right: (W + stageWidth) / 2 + PLACEMENT_CLEARANCE,
            bottom: STAGE_CLEAR_BOTTOM,
            width: stageWidth + PLACEMENT_CLEARANCE * 2,
            height: STAGE_CLEAR_BOTTOM - 40 + PLACEMENT_CLEARANCE
        };
    }

    function rectsOverlap(a, b) {
        return a.left < b.right && a.right > b.left &&
            a.top < b.bottom && a.bottom > b.top;
    }

    function validateSeatPlan(states, context, options) {
        if (!states.length) { return "Nothing to add."; }

        var stage = stageReservedRect();
        var existing = chips.map(function (el) {
            return inflateRect(stateBounds(el._st), PLACEMENT_CLEARANCE / 2);
        });
        var planned = [];
        var preserveInternalLayout = !!(
            options && options.preserveInternalLayout
        );

        for (var i = 0; i < states.length; i++) {
            var rect = stateBounds(states[i]);
            if (rect.left < 0 || rect.top < 0) {
                return "Cannot add " + context + " outside the hall origin.";
            }
            if (rectsOverlap(rect, stage)) {
                return "No room for " + context + " without entering the stage clearance.";
            }

            var padded = inflateRect(rect, PLACEMENT_CLEARANCE / 2);
            if (existing.some(function (obstacle) { return rectsOverlap(padded, obstacle); })) {
                return "Cannot add " + context + " because it would overlap existing seats.";
            }
            if (!preserveInternalLayout &&
                planned.some(function (other) { return rectsOverlap(padded, other); })) {
                return "The requested spacing is too small for " + context + ".";
            }
            planned.push(padded);
        }
        return null;
    }

    function commitSeatPlan(states, context, options) {
        var issue = validateSeatPlan(states, context, options);
        if (issue) {
            statusEl.textContent = issue;
            statusEl.className = "layout-status error-text";
            return [];
        }
        ensureCanvasFits(states);
        var added = createChips(states);
        afterStructureChange(added);
        return added;
    }

    function findGridAnchor(spec) {
        var bounds = usablePlacementBounds();
        var block = gridBlockSize(spec);
        var blockWidth = block.width;
        var blockHeight = block.height;
        var maxX = bounds.right - blockWidth;
        var maxY = bounds.bottom - blockHeight;
        if (maxX < bounds.left || maxY < bounds.top) { return null; }

        var obstacles = chips.map(function (el) {
            return inflateRect(stateBounds(el._st), PLACEMENT_CLEARANCE);
        });
        obstacles.push(stageReservedRect());

        var yCandidates = [bounds.top];
        obstacles.forEach(function (obstacle) {
            if (obstacle.bottom >= bounds.top && obstacle.bottom <= maxY) {
                yCandidates.push(Math.ceil(obstacle.bottom));
            }
        });
        yCandidates.sort(function (a, b) { return a - b; });
        yCandidates = yCandidates.filter(function (value, index, list) {
            return index === 0 || value !== list[index - 1];
        });

        for (var yi = 0; yi < yCandidates.length; yi++) {
            var y = yCandidates[yi];
            var x = bounds.left;
            while (x <= maxX) {
                var candidate = {
                    left: x,
                    top: y,
                    right: x + blockWidth,
                    bottom: y + blockHeight,
                    width: blockWidth,
                    height: blockHeight
                };
                var collisions = obstacles.filter(function (obstacle) {
                    return rectsOverlap(candidate, obstacle);
                });
                if (!collisions.length) {
                    return { x: Math.round(x), y: Math.round(y) };
                }
                x = Math.max.apply(null, collisions.map(function (obstacle) {
                    return obstacle.right;
                }));
            }
        }
        return null;
    }

    function findExpansionGridAnchor(spec) {
        var block = gridBlockSize(spec);
        var lastSeatBottom = chips.reduce(function (bottom, el) {
            return Math.max(bottom, stateBounds(el._st).bottom);
        }, STAGE_CLEAR_BOTTOM);
        var futureWidth = Math.max(W, block.width + LAYOUT_MARGIN * 2);
        return {
            x: Math.round((futureWidth - block.width) / 2),
            y: Math.ceil(lastSeatBottom + Math.max(PLACEMENT_CLEARANCE, spec.gapY))
        };
    }

    function generateSeatGrid() {
        var spec = readGridSpec(true);
        var count = spec.columns * spec.rows;
        if (count > MAX_BULK_SEATS) {
            statusEl.textContent = "Generate at most " + MAX_BULK_SEATS + " seats at a time.";
            statusEl.className = "layout-status error-text";
            return;
        }

        var anchor = findGridAnchor(spec) || findExpansionGridAnchor(spec);

        var firstRow = maxRow() + 1;
        var states = [];
        for (var rowOffset = 0; rowOffset < spec.rows; rowOffset++) {
            var rowIndex = firstRow + rowOffset;
            var rowLabel = letter(rowIndex);
            for (var columnOffset = 0; columnOffset < spec.columns; columnOffset++) {
                var seatNumber = columnOffset + 1;
                states.push({
                    id: null,
                    label: rowLabel + seatNumber,
                    rowLabel: rowLabel,
                    r: rowIndex,
                    c: seatNumber,
                    x: anchor.x + columnOffset * (spec.seatWidth + spec.gapX),
                    y: anchor.y + rowOffset * (spec.seatHeight + spec.gapY),
                    w: spec.seatWidth,
                    h: spec.seatHeight,
                    rot: 0,
                    section: spec.section,
                    sectionKey: spec.sectionKey
                });
            }
        }
        commitSeatPlan(states, "the " + spec.columns + " x " + spec.rows + " seat block");
    }

    function nextRowY(gap) {
        return Math.ceil(chips.reduce(function (bottom, el) {
            return Math.max(bottom, stateBounds(el._st).bottom);
        }, STAGE_CLEAR_BOTTOM) + gap);
    }

    function columnX(c, width) {
        var centers = chips.filter(function (el) { return el._st.c === c; }).map(function (el) {
            return el._st.x + el._st.w / 2;
        });
        return centers.length ? Math.round(median(centers) - width / 2) :
            START_X + (c - 1) * GAP_X;
    }

    function rightmostSeatInRow(r) {
        var seats = chips.filter(function (el) { return el._st.r === r; });
        return seats.reduce(function (rightmost, el) {
            if (!rightmost) { return el; }
            return stateBounds(el._st).right > stateBounds(rightmost._st).right ? el : rightmost;
        }, null);
    }

    btnAddRow().addEventListener("click", function () {
        var newR = maxRow() + 1;
        var cols = maxCol() || 1;
        var rl = letter(newR);
        var template = seatTemplate();
        var y = nextRowY(readGap(gridGapY, GAP_Y - DEF_H));
        var states = [];
        for (var c = 1; c <= cols; c++) {
            states.push({
                id: null, label: rl + c, rowLabel: rl, r: newR, c: c,
                x: columnX(c, template.w), y: y,
                w: template.w, h: template.h, rot: 0,
                section: template.section,
                sectionKey: template.sectionKey
            });
        }
        commitSeatPlan(states, "another row");
    });

    btnAddCol().addEventListener("click", function () {
        var newC = maxCol() + 1;
        var gap = readGap(gridGapX, GAP_X - DEF_W);
        var states = [];
        rowsPresent().forEach(function (r) {
            var rl = rowLabelFor(r);
            var rightmost = rightmostSeatInRow(r);
            var source = rightmost._st;
            states.push({
                id: null, label: rl + newC, rowLabel: rl, r: r, c: newC,
                x: Math.ceil(stateBounds(source).right + gap), y: source.y,
                w: source.w, h: source.h, rot: 0,
                section: source.section,
                sectionKey: source.sectionKey
            });
        });
        commitSeatPlan(states, "another column");
    });

    btnAddSeat().addEventListener("click", function () {
        var r, rl, x, y;
        var template = seatTemplate();
        var gapX = readGap(gridGapX, GAP_X - DEF_W);
        if (primary) {
            r = primary._st.r;
            rl = rowLabelFor(r);
            var rightmost = rightmostSeatInRow(r);
            x = Math.ceil(stateBounds(rightmost._st).right + gapX);
            y = primary._st.y;
        } else {
            r = maxRow() + 1;
            rl = letter(r);
            x = LAYOUT_MARGIN;
            y = nextRowY(readGap(gridGapY, GAP_Y - DEF_H));
        }
        var c = maxColInRow(r) + 1;
        commitSeatPlan([{
            id: null, label: rl + c, rowLabel: rl, r: r, c: c,
            x: x, y: y,
            w: template.w, h: template.h, rot: 0,
            section: template.section,
            sectionKey: template.sectionKey
        }], "another seat");
    });

    if (btnAddGrid) {
        btnAddGrid.addEventListener("click", generateSeatGrid);
        [gridColumns, gridRows, gridGapX, gridGapY].forEach(function (input) {
            if (input) { input.addEventListener("input", refreshGridCapacity); }
        });
        refreshGridCapacity();
    }

    function removeChips(list) {
        if (!list.length) { return; }
        if (chips.length - list.length < 1) {
            statusEl.textContent = "A hall must keep at least one seat.";
            statusEl.className = "layout-status error-text";
            return;
        }
        list.forEach(function (el) {
            var i = chips.indexOf(el);
            if (i !== -1) { chips.splice(i, 1); }
            el.remove();
        });
        afterStructureChange([]);
    }

    btnDelSeat().addEventListener("click", function () {
        if (!selection.length) {
            statusEl.textContent = "Select one or more seats to delete.";
            statusEl.className = "layout-status";
            return;
        }
        removeChips(selection.slice());
    });
    btnDelRow().addEventListener("click", function () {
        if (!primary) { statusEl.textContent = "Select a seat in the row to delete."; return; }
        var r = primary._st.r;
        removeChips(chips.filter(function (el) { return el._st.r === r; }));
    });
    btnDelCol().addEventListener("click", function () {
        if (!primary) { statusEl.textContent = "Select a seat in the column to delete."; return; }
        var c = primary._st.c;
        removeChips(chips.filter(function (el) { return el._st.c === c; }));
    });

    function selectRelatedSeats(predicate, emptyMessage) {
        if (!primary) {
            statusEl.textContent = "Select a seat first.";
            statusEl.className = "layout-status";
            return;
        }
        var related = chips.filter(predicate);
        if (!related.length) {
            statusEl.textContent = emptyMessage;
            statusEl.className = "layout-status";
            return;
        }
        setSelection(related);
    }

    on("selectSeatRow", function () {
        var row = primary && primary._st.r;
        selectRelatedSeats(function (el) { return el._st.r === row; }, "That row has no seats.");
    });
    on("selectSeatColumn", function () {
        var column = primary && primary._st.c;
        selectRelatedSeats(function (el) { return el._st.c === column; }, "That column has no seats.");
    });
    on("selectSectionSeats", function () {
        var section = primary && primary._st.sectionKey;
        if (!primary) {
            statusEl.textContent = "Select a seat first.";
            statusEl.className = "layout-status";
            return;
        }
        if (!section) {
            statusEl.textContent = "The selected seat is not assigned to a section.";
            statusEl.className = "layout-status";
            return;
        }
        selectRelatedSeats(function (el) {
            return el._st.sectionKey === section;
        }, "That section has no seats.");
    });
    on("selectAllSeats", function () { setSelection(chips.slice()); });

    // --- Arrange: align / distribute / snap / group-rotate -------------------
    function centersOf(list) {
        return list.map(function (el) {
            return { el: el, cx: el._st.x + el._st.w / 2, cy: el._st.y + el._st.h / 2 };
        });
    }
    function setCenter(el, cx, cy) {
        el._st.x = Math.round(cx - el._st.w / 2);
        el._st.y = Math.round(cy - el._st.h / 2);
        clampPosition(el);
    }
    function requireSel(min) {
        if (selection.length < min) {
            statusEl.textContent = min > 1 ? "Select two or more seats first." : "Select a seat first.";
            statusEl.className = "layout-status";
            return false;
        }
        return true;
    }
    function afterArrange() {
        ensureCanvasFits(selection.map(function (el) { return el._st; }));
        selection.forEach(render);
        refreshInspector();
        markDirty();
    }
    function arrangeSafely(mutator) {
        var original = selection.map(function (el) {
            return { el: el, state: copy(el._st) };
        });
        mutator();
        var issue = validateSelectionArrangement();
        if (issue) {
            original.forEach(function (item) { item.el._st = item.state; });
            selection.forEach(render);
            refreshInspector();
            statusEl.textContent = issue;
            statusEl.className = "layout-status error-text";
            return false;
        }
        afterArrange();
        return true;
    }
    function median(nums) {
        var a = nums.slice().sort(function (x, y) { return x - y; });
        var m = Math.floor(a.length / 2);
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }

    function logicalRows(list) {
        var grouped = {};
        list.forEach(function (el) {
            var key = String(el._st.r);
            (grouped[key] = grouped[key] || []).push(el);
        });
        return Object.keys(grouped).map(function (key) {
            var seats = grouped[key];
            return {
                row: int(key, 0),
                seats: seats,
                top: Math.min.apply(null, seats.map(function (el) {
                    return stateBounds(el._st).top;
                }))
            };
        }).sort(function (a, b) {
            return a.row === b.row ? a.top - b.top : a.row - b.row;
        });
    }

    function boundsOfSeats(list) {
        var bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
        list.forEach(function (el) {
            var box = stateBounds(el._st);
            bounds.left = Math.min(bounds.left, box.left);
            bounds.top = Math.min(bounds.top, box.top);
            bounds.right = Math.max(bounds.right, box.right);
            bounds.bottom = Math.max(bounds.bottom, box.bottom);
        });
        if (!list.length) {
            return { left: 0, top: 0, right: 0, bottom: 0 };
        }
        return bounds;
    }

    function commonGap(values) {
        if (!values.length) { return null; }
        var min = Math.min.apply(null, values);
        var max = Math.max.apply(null, values);
        if (max - min > 1) { return null; }
        return Math.round(values.reduce(function (sum, value) {
            return sum + value;
        }, 0) / values.length);
    }

    function measuredColumnGap(rows) {
        var gaps = [];
        rows.forEach(function (row) {
            var seats = row.seats.slice().sort(function (a, b) {
                return a._st.c === b._st.c
                    ? stateBounds(a._st).left - stateBounds(b._st).left
                    : a._st.c - b._st.c;
            });
            for (var i = 1; i < seats.length; i++) {
                gaps.push(stateBounds(seats[i]._st).left - stateBounds(seats[i - 1]._st).right);
            }
        });
        return commonGap(gaps);
    }

    function measuredRowGap(rows) {
        var gaps = [];
        for (var i = 1; i < rows.length; i++) {
            gaps.push(
                boundsOfSeats(rows[i].seats).top -
                boundsOfSeats(rows[i - 1].seats).bottom
            );
        }
        return commonGap(gaps);
    }

    function refreshArrangeTools() {
        if (!arrangeTools) { return; }
        var show = editing && selection.length >= 2;
        arrangeTools.classList.toggle("hidden", !show);
        if (!show) { return; }

        var rows = logicalRows(selection);
        var gapX = measuredColumnGap(rows);
        var gapY = measuredRowGap(rows);
        if (selectionGapX) {
            selectionGapX.value = gapX == null ? "" : gapX;
            selectionGapX.placeholder = gapX == null ? "Mixed" : "";
        }
        if (selectionGapY) {
            selectionGapY.value = gapY == null ? "" : gapY;
            selectionGapY.placeholder = rows.length < 2 ? "Need 2 rows" : "Mixed";
        }
        if (selectionSpacingSummary) {
            selectionSpacingSummary.textContent =
                selection.length + " seats / " + rows.length + " row" +
                (rows.length === 1 ? "" : "s");
        }
    }

    function applyColumnGap(rows, gap) {
        rows.forEach(function (row) {
            var seats = row.seats.slice().sort(function (a, b) {
                return a._st.c === b._st.c
                    ? stateBounds(a._st).left - stateBounds(b._st).left
                    : a._st.c - b._st.c;
            });
            if (seats.length < 2) { return; }
            var right = stateBounds(seats[0]._st).right;
            for (var i = 1; i < seats.length; i++) {
                var current = stateBounds(seats[i]._st);
                seats[i]._st.x = Math.round(seats[i]._st.x + right + gap - current.left);
                right = stateBounds(seats[i]._st).right;
            }
        });
    }

    function applyRowGap(rows, gap) {
        if (rows.length < 2) { return; }
        var bottom = boundsOfSeats(rows[0].seats).bottom;
        for (var i = 1; i < rows.length; i++) {
            var rowBounds = boundsOfSeats(rows[i].seats);
            var shift = bottom + gap - rowBounds.top;
            rows[i].seats.forEach(function (el) {
                el._st.y = Math.round(el._st.y + shift);
            });
            bottom = boundsOfSeats(rows[i].seats).bottom;
        }
    }

    function validateSelectionArrangement() {
        var selectedSet = selection.slice();
        var obstacles = chips.filter(function (el) {
            return selectedSet.indexOf(el) === -1;
        }).map(function (el) {
            return { label: el._st.label, bounds: stateBounds(el._st) };
        });
        var stage = stageReservedRect();
        var planned = [];

        for (var i = 0; i < selection.length; i++) {
            var seat = selection[i]._st;
            var bounds = stateBounds(seat);
            if (rectsOverlap(bounds, stage)) {
                return "Arrangement would move " + seat.label + " into the stage area.";
            }
            for (var j = 0; j < obstacles.length; j++) {
                if (rectsOverlap(bounds, obstacles[j].bounds)) {
                    return "Arrangement would overlap " + seat.label + " with " +
                        obstacles[j].label + ".";
                }
            }
            for (var k = 0; k < planned.length; k++) {
                if (rectsOverlap(bounds, planned[k].bounds)) {
                    return "Arrangement would overlap " + seat.label + " with " +
                        planned[k].label + ".";
                }
            }
            planned.push({ label: seat.label, bounds: bounds });
        }
        return null;
    }

    function applyExactSpacing() {
        if (!requireSel(2)) { return; }
        var hasGapX = selectionGapX && selectionGapX.value.trim() !== "";
        var hasGapY = selectionGapY && selectionGapY.value.trim() !== "";
        if (!hasGapX && !hasGapY) {
            statusEl.textContent = "Enter a column gap, a row gap, or both.";
            statusEl.className = "layout-status";
            return;
        }

        var gapX = hasGapX ? clamp(int(selectionGapX.value, 0), 0, 1000) : null;
        var gapY = hasGapY ? clamp(int(selectionGapY.value, 0), 0, 1000) : null;
        var original = selection.map(function (el) {
            return { el: el, state: copy(el._st) };
        });
        var before = boundsOfSeats(selection);
        var rows = logicalRows(selection);

        if (gapX != null) { applyColumnGap(rows, gapX); }
        if (gapY != null) { applyRowGap(logicalRows(selection), gapY); }

        if (spacingAnchor === "center") {
            var after = boundsOfSeats(selection);
            var dx = (before.left + before.right - after.left - after.right) / 2;
            var dy = (before.top + before.bottom - after.top - after.bottom) / 2;
            selection.forEach(function (el) {
                el._st.x = Math.round(el._st.x + dx);
                el._st.y = Math.round(el._st.y + dy);
            });
        }

        var movedBounds = boundsOfSeats(selection);
        var originDx = movedBounds.left < 0 ? -movedBounds.left : 0;
        var originDy = movedBounds.top < 0 ? -movedBounds.top : 0;
        if (originDx || originDy) {
            selection.forEach(function (el) {
                el._st.x = Math.round(el._st.x + originDx);
                el._st.y = Math.round(el._st.y + originDy);
            });
        }

        var issue = validateSelectionArrangement();
        if (issue) {
            original.forEach(function (item) { item.el._st = item.state; });
            selection.forEach(render);
            statusEl.textContent = issue;
            statusEl.className = "layout-status error-text";
            return;
        }
        afterArrange();
    }

    spacingAnchorButtons.forEach(function (button) {
        button.addEventListener("click", function () {
            spacingAnchor = button.dataset.anchor === "center" ? "center" : "top-left";
            spacingAnchorButtons.forEach(function (item) {
                var active = item === button;
                item.classList.toggle("active", active);
                item.setAttribute("aria-pressed", active ? "true" : "false");
            });
        });
    });
    on("applySelectionSpacing", applyExactSpacing);

    // Align: with one seat selected, aligns it relative to the whole canvas; with several,
    // aligns them relative to the selection's bounding box.
    function alignSelection(kind) {
        if (!requireSel(1)) { return; }
        arrangeSafely(function () {
            var left, right, top, bottom, cX, cY;
            var b = window.SeatBoundsOverride;
            if (b) {
                // Section Edit view: always align to the SECTION bbox, never the canvas.
                // This way "Center" / "Left" / "Top" stay inside the section even with one seat.
                left = b.left; right = b.right; top = b.top; bottom = b.bottom;
                cX = (b.left + b.right) / 2; cY = (b.top + b.bottom) / 2;
            } else if (selection.length === 1) {
                left = 0; right = W; top = 0; bottom = H; cX = W / 2; cY = H / 2;
            } else {
                left = Math.min.apply(null, selection.map(function (e) { return e._st.x; }));
                right = Math.max.apply(null, selection.map(function (e) { return e._st.x + e._st.w; }));
                top = Math.min.apply(null, selection.map(function (e) { return e._st.y; }));
                bottom = Math.max.apply(null, selection.map(function (e) { return e._st.y + e._st.h; }));
                cX = (left + right) / 2; cY = (top + bottom) / 2;
            }
            selection.forEach(function (e) {
                switch (kind) {
                    case "left": e._st.x = Math.round(left); break;
                    case "right": e._st.x = Math.round(right - e._st.w); break;
                    case "top": e._st.y = Math.round(top); break;
                    case "bottom": e._st.y = Math.round(bottom - e._st.h); break;
                    case "centerX": e._st.x = Math.round(cX - e._st.w / 2); break;
                    case "middleY": e._st.y = Math.round(cY - e._st.h / 2); break;
                }
                clampPosition(e);
            });
        });
    }
    on("alLeft", function () { alignSelection("left"); });
    on("alRight", function () { alignSelection("right"); });
    on("alTop", function () { alignSelection("top"); });
    on("alBottom", function () { alignSelection("bottom"); });
    on("alCenterX", function () { alignSelection("centerX"); });
    on("alMiddle", function () { alignSelection("middleY"); });
    on("distH", function () {
        if (!requireSel(3)) { return; }
        arrangeSafely(function () {
            var cs = centersOf(selection).sort(function (a, b) { return a.cx - b.cx; });
            var first = cs[0].cx, last = cs[cs.length - 1].cx;
            var step = (last - first) / (cs.length - 1);
            cs.forEach(function (o, i) { setCenter(o.el, first + step * i, o.cy); });
        });
    });
    on("distV", function () {
        if (!requireSel(3)) { return; }
        arrangeSafely(function () {
            var cs = centersOf(selection).sort(function (a, b) { return a.cy - b.cy; });
            var first = cs[0].cy, last = cs[cs.length - 1].cy;
            var step = (last - first) / (cs.length - 1);
            cs.forEach(function (o, i) { setCenter(o.el, o.cx, first + step * i); });
        });
    });
    // Snap against the selected block only. Pasted blocks reuse column numbers, so including
    // the source seats would pull a copy back toward the original arrangement.
    on("snapGrid", function () {
        if (!requireSel(1)) { return; }
        arrangeSafely(function () {
            var colX = {}, rowY = {};
            selection.forEach(function (el) {
                var cx = el._st.x + el._st.w / 2, cy = el._st.y + el._st.h / 2;
                (colX[el._st.c] = colX[el._st.c] || []).push(cx);
                (rowY[el._st.r] = rowY[el._st.r] || []).push(cy);
            });
            selection.forEach(function (el) {
                setCenter(el, median(colX[el._st.c]), median(rowY[el._st.r]));
            });
        });
    });
    on("straighten", function () {
        if (!requireSel(1)) { return; }
        arrangeSafely(function () {
            selection.forEach(function (e) { e._st.rot = 0; });
        });
    });
    // Rotate the whole selection as one rigid body around its centroid.
    function rotateGroup(theta) {
        if (!requireSel(1)) { return; }
        arrangeSafely(function () {
            var cs = centersOf(selection);
            var ox = cs.reduce(function (s, o) { return s + o.cx; }, 0) / cs.length;
            var oy = cs.reduce(function (s, o) { return s + o.cy; }, 0) / cs.length;
            var rad = theta * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
            cs.forEach(function (o) {
                var dx = o.cx - ox, dy = o.cy - oy;
                setCenter(o.el, ox + dx * cos - dy * sin, oy + dx * sin + dy * cos);
                o.el._st.rot = clamp(Math.round(o.el._st.rot + theta), -180, 180);
            });
        });
    }
    function groupStep() { return clamp(int(document.getElementById("groupRotStep").value, 15), 1, 180); }
    on("rotCCW", function () { rotateGroup(-groupStep()); });
    on("rotCW", function () { rotateGroup(groupStep()); });

    // Bow the selected seats along a parabola. Up/Down curve a horizontal row (offsets Y);
    // Left/Right curve a vertical column (offsets X). The ends stay put; the middle bows out.
    function curveSelection(axis, sign) {
        if (!requireSel(3)) { return; }
        arrangeSafely(function () {
            var amount = clamp(int(document.getElementById("curveAmt").value, 40), 1, 400);
            var cs = centersOf(selection);
            if (axis === "y") {
                cs.sort(function (a, b) { return a.cx - b.cx; });
                var baseY = cs.reduce(function (s, o) { return s + o.cy; }, 0) / cs.length;
                cs.forEach(function (o, i) {
                    var t = (i / (cs.length - 1)) * 2 - 1;
                    setCenter(o.el, o.cx, baseY + sign * amount * (1 - t * t));
                });
            } else {
                cs.sort(function (a, b) { return a.cy - b.cy; });
                var baseX = cs.reduce(function (s, o) { return s + o.cx; }, 0) / cs.length;
                cs.forEach(function (o, i) {
                    var t = (i / (cs.length - 1)) * 2 - 1;
                    setCenter(o.el, baseX + sign * amount * (1 - t * t), o.cy);
                });
            }
        });
    }
    on("curveUp", function () { curveSelection("y", -1); });
    on("curveDown", function () { curveSelection("y", 1); });
    on("curveLeft", function () { curveSelection("x", -1); });
    on("curveRight", function () { curveSelection("x", 1); });

    // --- Tables (non-bookable layout objects) --------------------------------
    // Tables share the seat canvas coordinate space (x/y top-left, w = footprint width,
    // d = footprint depth) so the same 2D/3D editor arranges both, but they are kept in a
    // separate list with their own single-selection + inspector. They never enter seat
    // selection, capacity or the booking flow — the Save payload sends them as `layoutObjects`.
    var OBJECT_TYPES = { TABLE: 1, SCREEN: 1 };
    var TABLE_SHAPES = { SQUARE: 1, RECTANGLE: 1, CIRCLE: 1 };
    var T_MIN = 20, T_MAX = 600, T_H_MIN = 6, T_H_MAX = 300, T_Z_MAX = 400;
    var T_DEF = {
        SQUARE: { w: 90, d: 90 },
        RECTANGLE: { w: 150, d: 84 },
        CIRCLE: { w: 104, d: 104 }
    };
    var SCREEN_DEF = { w: 220, d: 24, z: 60, height: 130 };
    var tableEls = [];
    var tableSel = null;
    var nextTableDraft = 1;
    var savedTables = [];

    var tableTools = document.getElementById("tableTools");
    var tableInspector = document.getElementById("tableInspector");
    var tSelLabel = document.getElementById("tSelLabel");
    var tObjectType = document.getElementById("tObjectType");
    var tShapeField = document.getElementById("tShapeField");
    var tShape = document.getElementById("tShape");
    var tName = document.getElementById("tName");
    var tWidth = document.getElementById("tWidth");
    var tWidthLabel = document.getElementById("tWidthLabel");
    var tLength = document.getElementById("tLength");
    var tLengthField = document.getElementById("tLengthField");
    var tLengthLabel = document.getElementById("tLengthLabel");
    var tHeight = document.getElementById("tHeight");
    var tHeightLabel = document.getElementById("tHeightLabel");
    var tElevation = document.getElementById("tElevation");
    var tElevationLabel = document.getElementById("tElevationLabel");
    var tRotation = document.getElementById("tRotation");
    var tRotVal = document.getElementById("tRotVal");

    Array.prototype.slice.call(canvas.querySelectorAll(".table-chip")).forEach(function (el) {
        el._tt = readTableEl(el);
        ensureTableKey(el._tt);
        tableEls.push(el);
        renderTable(el);
        el.addEventListener("pointerdown", onTablePointerDown);
    });
    savedTables = tableEls.map(function (el) { return copyTable(el._tt); });

    function readTableEl(el) {
        var objectType = OBJECT_TYPES[el.dataset.objectType] ? el.dataset.objectType : "TABLE";
        var shape = objectType === "SCREEN"
            ? "RECTANGLE"
            : (TABLE_SHAPES[el.dataset.shape] ? el.dataset.shape : "SQUARE");
        var def = objectType === "SCREEN" ? SCREEN_DEF : T_DEF[shape];
        var t = {
            id: hasVal(el.dataset.id) ? int(el.dataset.id, null) : null,
            objectType: objectType,
            shape: shape,
            label: el.dataset.label && el.dataset.label !== "null" ? el.dataset.label : "",
            x: Math.max(0, int(el.dataset.x, 60)),
            y: Math.max(0, int(el.dataset.y, 60)),
            w: clamp(int(el.dataset.w, def.w), T_MIN, T_MAX),
            d: clamp(int(el.dataset.d, def.d), T_MIN, T_MAX),
            z: clamp(int(el.dataset.z, def.z || 0), 0, T_Z_MAX),
            height: clamp(int(el.dataset.height, def.height || 40), T_H_MIN, T_H_MAX),
            rot: clamp(int(el.dataset.rot, 0), -180, 180)
        };
        if (shape !== "RECTANGLE") { t.d = t.w; }
        return t;
    }

    function renderTable(el) {
        var t = el._tt;
        t.objectType = OBJECT_TYPES[t.objectType] ? t.objectType : "TABLE";
        if (t.objectType === "SCREEN") { t.shape = "RECTANGLE"; }
        if (t.shape !== "RECTANGLE") { t.d = t.w; }
        el.style.left = t.x + "px";
        el.style.top = t.y + "px";
        el.style.width = t.w + "px";
        el.style.height = t.d + "px";
        el.style.transform = "rotate(" + t.rot + "deg)";
        var noun = t.objectType === "SCREEN" ? "Screen" : "Table";
        el.className = "table-chip " + t.objectType + " " + t.shape +
            (el === tableSel ? " selected" : "");
        el.textContent = "";
        var label = document.createElement("span");
        label.className = "object-label";
        label.textContent = t.label ? t.label : noun;
        el.appendChild(label);
        if (editing && el === tableSel) { appendObjectHandles(el); }
        el.title = (t.label ? t.label + " — " : "") + noun +
            (t.objectType === "TABLE" ? " (" + t.shape.toLowerCase() + ")" : "");
    }

    function appendObjectHandles(el) {
        var frame = document.createElement("span");
        frame.className = "object-transform-frame";
        el.appendChild(frame);

        [
            { dir: "e", cls: "edge-e", title: "Resize width" },
            { dir: "w", cls: "edge-w", title: "Resize width" },
            { dir: "s", cls: "edge-s", title: "Resize depth" },
            { dir: "n", cls: "edge-n", title: "Resize depth" }
        ].forEach(function (spec) {
            var handle = document.createElement("span");
            handle.className = "object-resize-handle " + spec.cls;
            handle.title = spec.title;
            handle.setAttribute("aria-label", spec.title);
            handle.addEventListener("pointerdown", function (e) {
                startObjectEdgeResize(e, el, spec.dir);
            });
            el.appendChild(handle);
        });

        var corner = document.createElement("span");
        corner.className = "object-resize-handle corner-se";
        corner.title = "Resize proportionally";
        corner.setAttribute("aria-label", "Resize proportionally");
        corner.addEventListener("pointerdown", function (e) {
            startObjectUniformResize(e, el);
        });
        el.appendChild(corner);

        var stem = document.createElement("span");
        stem.className = "object-rotate-stem";
        el.appendChild(stem);

        var rotate = document.createElement("span");
        rotate.className = "object-rotate-handle";
        rotate.title = "Rotate object";
        rotate.setAttribute("aria-label", "Rotate object");
        rotate.addEventListener("pointerdown", function (e) {
            startObjectRotate(e, el);
        });
        el.appendChild(rotate);
    }

    function canvasPoint(e) {
        var rect = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * W / Math.max(1, rect.width),
            y: (e.clientY - rect.top) * H / Math.max(1, rect.height)
        };
    }

    function startObjectUniformResize(e, el) {
        if (!editing || el !== tableSel) { return; }
        e.preventDefault();
        e.stopPropagation();
        var t = el._tt;
        var original = { x: t.x, y: t.y, w: t.w, d: t.d };
        var cx = original.x + original.w / 2;
        var cy = original.y + original.d / 2;
        var start = canvasPoint(e);
        var startDistance = Math.max(8, Math.hypot(start.x - cx, start.y - cy));
        var minScale = Math.max(T_MIN / original.w, T_MIN / original.d);
        var maxScale = Math.min(T_MAX / original.w, T_MAX / original.d);

        function move(ev) {
            var point = canvasPoint(ev);
            var scale = clamp(
                Math.hypot(point.x - cx, point.y - cy) / startDistance,
                minScale,
                maxScale
            );
            t.w = Math.round(original.w * scale);
            t.d = Math.round(original.d * scale);
            if (t.shape !== "RECTANGLE") { t.d = t.w; }
            t.x = Math.max(0, Math.round(cx - t.w / 2));
            t.y = Math.max(0, Math.round(cy - t.d / 2));
            renderTable(el);
            refreshTableInspector();
        }

        finishObjectTransform(move, el);
    }

    function startObjectEdgeResize(e, el, dir) {
        if (!editing || el !== tableSel) { return; }
        e.preventDefault();
        e.stopPropagation();
        var t = el._tt;
        var original = { x: t.x, y: t.y, w: t.w, d: t.d, rot: t.rot };
        var center = {
            x: original.x + original.w / 2,
            y: original.y + original.d / 2
        };
        var angle = original.rot * Math.PI / 180;
        var xAxis = { x: Math.cos(angle), y: Math.sin(angle) };
        var yAxis = { x: -Math.sin(angle), y: Math.cos(angle) };
        var horizontal = dir === "e" || dir === "w";
        var axis = horizontal ? xAxis : yAxis;
        var sign = dir === "e" || dir === "s" ? 1 : -1;
        var movingAxis = { x: axis.x * sign, y: axis.y * sign };
        var span = horizontal ? original.w : original.d;
        var anchor = {
            x: center.x - movingAxis.x * span / 2,
            y: center.y - movingAxis.y * span / 2
        };

        function move(ev) {
            var point = canvasPoint(ev);
            var extent = (point.x - anchor.x) * movingAxis.x +
                (point.y - anchor.y) * movingAxis.y;
            var nextSpan = clamp(Math.round(extent), T_MIN, T_MAX);
            var nextW = horizontal ? nextSpan : original.w;
            var nextD = horizontal ? original.d : nextSpan;
            if (t.shape !== "RECTANGLE") {
                nextW = nextSpan;
                nextD = nextSpan;
            }
            var nextCenter = {
                x: horizontal
                    ? anchor.x + movingAxis.x * nextSpan / 2
                    : center.x,
                y: horizontal
                    ? anchor.y + movingAxis.y * nextSpan / 2
                    : center.y
            };
            if (!horizontal) {
                nextCenter.x = anchor.x + movingAxis.x * nextSpan / 2;
                nextCenter.y = anchor.y + movingAxis.y * nextSpan / 2;
            }
            t.w = nextW;
            t.d = nextD;
            t.x = Math.max(0, Math.round(nextCenter.x - nextW / 2));
            t.y = Math.max(0, Math.round(nextCenter.y - nextD / 2));
            renderTable(el);
            refreshTableInspector();
        }

        finishObjectTransform(move, el);
    }

    function startObjectRotate(e, el) {
        if (!editing || el !== tableSel) { return; }
        e.preventDefault();
        e.stopPropagation();
        var t = el._tt;
        var center = { x: t.x + t.w / 2, y: t.y + t.d / 2 };
        var start = canvasPoint(e);
        var startAngle = Math.atan2(start.y - center.y, start.x - center.x);
        var originalRotation = t.rot;

        function move(ev) {
            var point = canvasPoint(ev);
            var angle = Math.atan2(point.y - center.y, point.x - center.x);
            var degrees = originalRotation + (angle - startAngle) * 180 / Math.PI;
            t.rot = normalizeDegrees(Math.round(degrees));
            renderTable(el);
            refreshTableInspector();
        }

        finishObjectTransform(move, el);
    }

    function finishObjectTransform(move, el) {
        function up() {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            ensureTableFits(el._tt);
            refreshTableInspector();
            markDirty();
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }

    function normalizeDegrees(value) {
        while (value > 180) { value -= 360; }
        while (value < -180) { value += 360; }
        return value;
    }

    function onTablePointerDown(e) {
        if (!editing) { return; }
        e.preventDefault();
        e.stopPropagation();
        var el = e.currentTarget;
        selectTable(el);

        var rect = canvas.getBoundingClientRect();
        var scaleX = rect.width / W || 1;
        var scaleY = rect.height / H || 1;
        var startX = e.clientX, startY = e.clientY;
        var ox = el._tt.x, oy = el._tt.y;

        el.setPointerCapture(e.pointerId);
        function move(ev) {
            el._tt.x = Math.max(0, Math.round(ox + (ev.clientX - startX) / scaleX));
            el._tt.y = Math.max(0, Math.round(oy + (ev.clientY - startY) / scaleY));
            renderTable(el);
            ensureTableFits(el._tt);
        }
        function up() {
            el.releasePointerCapture(e.pointerId);
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            markDirty();
        }
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
    }

    function selectTable(el) {
        if (selection.length) { setSelection([]); }
        var prev = tableSel;
        tableSel = el;
        if (prev && prev !== el) { renderTable(prev); }
        if (el) { renderTable(el); }
        refreshTableInspector();
        notifyBridge("tableSelection");
    }

    function clearTableSelection() {
        if (!tableSel) { return; }
        var prev = tableSel;
        tableSel = null;
        renderTable(prev);
        refreshTableInspector();
        notifyBridge("tableSelection");
    }

    function refreshTableInspector() {
        if (!tableInspector) { return; }
        if (!tableSel || !editing) { tableInspector.classList.add("hidden"); return; }
        tableInspector.classList.remove("hidden");
        var t = tableSel._tt;
        var noun = t.objectType === "SCREEN" ? "Screen" : "Table";
        tSelLabel.textContent = (t.label ? t.label : noun) +
            (t.objectType === "TABLE" ? "  (" + t.shape.toLowerCase() + ")" : "");
        if (tObjectType) { tObjectType.value = t.objectType; }
        if (tShape) { tShape.value = t.shape; }
        if (tName) { tName.value = t.label; }
        if (tWidth) { tWidth.value = t.w; }
        if (tLength) { tLength.value = t.d; }
        if (tHeight) { tHeight.value = t.height; }
        if (tElevation) { tElevation.value = t.z; }
        if (tRotation) { tRotation.value = t.rot; }
        if (tRotVal) { tRotVal.textContent = t.rot; }
        applyShapeUiHints(t);
    }

    function applyShapeUiHints(t) {
        var isScreen = t.objectType === "SCREEN";
        var shape = t.shape;
        if (tShapeField) { tShapeField.classList.toggle("hidden", isScreen); }
        if (tLengthField) {
            tLengthField.classList.toggle("hidden", !isScreen && shape !== "RECTANGLE");
        }
        if (tWidthLabel) {
            tWidthLabel.textContent = isScreen ? "Screen width (px)"
                : shape === "CIRCLE" ? "Diameter (px)"
                : (shape === "SQUARE" ? "Size (px)" : "Width (px)");
        }
        if (tLengthLabel) {
            tLengthLabel.textContent = isScreen ? "Footprint depth (px)" : "Length (px)";
        }
        if (tHeightLabel) {
            tHeightLabel.textContent = isScreen ? "Screen height (px)" : "Height (px)";
        }
        if (tElevationLabel) {
            tElevationLabel.textContent = isScreen ? "Bottom elevation (px)" : "Elevation Z (px)";
        }
        if (tName) {
            tName.placeholder = isScreen ? "e.g. Main screen" : "e.g. Head table";
        }
    }

    if (tObjectType) {
        tObjectType.addEventListener("change", function () {
            if (!tableSel) { return; }
            var t = tableSel._tt;
            var nextType = OBJECT_TYPES[tObjectType.value] ? tObjectType.value : "TABLE";
            if (nextType === t.objectType) { return; }
            t.objectType = nextType;
            t.shape = "RECTANGLE";
            if (nextType === "SCREEN") {
                t.w = SCREEN_DEF.w;
                t.d = SCREEN_DEF.d;
                t.z = SCREEN_DEF.z;
                t.height = SCREEN_DEF.height;
            }
            renderTable(tableSel);
            refreshTableInspector();
            ensureTableFits(t);
            markDirty();
        });
    }

    if (tShape) {
        tShape.addEventListener("change", function () {
            if (!tableSel) { return; }
            var t = tableSel._tt;
            if (t.objectType === "SCREEN") { return; }
            t.shape = TABLE_SHAPES[tShape.value] ? tShape.value : "SQUARE";
            if (t.shape !== "RECTANGLE") { t.d = t.w; }
            renderTable(tableSel);
            refreshTableInspector();
            ensureTableFits(t);
            markDirty();
        });
    }
    if (tName) {
        tName.addEventListener("input", function () {
            if (!tableSel) { return; }
            tableSel._tt.label = tName.value.slice(0, 80);
            renderTable(tableSel);
            markDirty();
        });
    }
    if (tWidth) {
        tWidth.addEventListener("change", function () {
            if (!tableSel) { return; }
            var v = clamp(int(tWidth.value, 90), T_MIN, T_MAX);
            tWidth.value = v;
            var t = tableSel._tt;
            t.w = v;
            if (t.shape !== "RECTANGLE") { t.d = v; if (tLength) { tLength.value = v; } }
            renderTable(tableSel);
            ensureTableFits(t);
            markDirty();
        });
    }
    if (tLength) {
        tLength.addEventListener("change", function () {
            if (!tableSel) { return; }
            var v = clamp(int(tLength.value, 84), T_MIN, T_MAX);
            tLength.value = v;
            var t = tableSel._tt;
            t.d = v;
            if (t.shape !== "RECTANGLE") { t.w = v; if (tWidth) { tWidth.value = v; } }
            renderTable(tableSel);
            ensureTableFits(t);
            markDirty();
        });
    }
    if (tHeight) {
        tHeight.addEventListener("change", function () {
            if (!tableSel) { return; }
            tableSel._tt.height = clamp(int(tHeight.value, 40), T_H_MIN, T_H_MAX);
            tHeight.value = tableSel._tt.height;
            markDirty();
        });
    }
    if (tElevation) {
        tElevation.addEventListener("change", function () {
            if (!tableSel) { return; }
            tableSel._tt.z = clamp(int(tElevation.value, 0), 0, T_Z_MAX);
            tElevation.value = tableSel._tt.z;
            markDirty();
        });
    }
    if (tRotation) {
        tRotation.addEventListener("input", function () {
            if (!tableSel) { return; }
            var v = clamp(int(tRotation.value, 0), -180, 180);
            if (tRotVal) { tRotVal.textContent = v; }
            tableSel._tt.rot = v;
            renderTable(tableSel);
            markDirty();
        });
    }

    function addTable(shape, objectType) {
        objectType = OBJECT_TYPES[objectType] ? objectType : "TABLE";
        if (objectType === "SCREEN") { shape = "RECTANGLE"; }
        var def = objectType === "SCREEN" ? SCREEN_DEF : (T_DEF[shape] || T_DEF.SQUARE);
        var el = document.createElement("span");
        el._tt = {
            id: null,
            objectType: objectType,
            shape: shape,
            label: "",
            x: Math.max(0, Math.round(W / 2 - def.w / 2)),
            y: Math.max(0, Math.round(H / 2 - def.d / 2)),
            w: def.w,
            d: def.d,
            z: def.z || 0,
            height: def.height || 40,
            rot: 0
        };
        ensureTableKey(el._tt);
        el.addEventListener("pointerdown", onTablePointerDown);
        canvas.appendChild(el);
        tableEls.push(el);
        renderTable(el);
        ensureTableFits(el._tt);
        selectTable(el);
        structureChanged = true;
        markDirty();
    }
    on("btnAddSquare", function () { addTable("SQUARE", "TABLE"); });
    on("btnAddRect", function () { addTable("RECTANGLE", "TABLE"); });
    on("btnAddCircle", function () { addTable("CIRCLE", "TABLE"); });
    on("btnAddScreen", function () { addTable("RECTANGLE", "SCREEN"); });
    on("btnDelTable", function () {
        if (!tableSel) {
            statusEl.textContent = "Select an object to delete.";
            statusEl.className = "layout-status";
            return;
        }
        var el = tableSel;
        tableSel = null;
        var i = tableEls.indexOf(el);
        if (i !== -1) { tableEls.splice(i, 1); }
        el.remove();
        refreshTableInspector();
        structureChanged = true;
        markDirty();
        notifyBridge("tableSelection");
    });

    function ensureTableFits(t) {
        ensureCanvasFits([{ x: t.x, y: t.y, w: t.w, h: t.d, rot: t.rot }]);
    }

    function ensureTableKey(t) {
        if (!t.key) { t.key = t.id != null ? "table:" + t.id : "tdraft:" + nextTableDraft++; }
        return t.key;
    }

    function copyTable(t) {
        return {
            id: t.id, objectType: t.objectType || "TABLE",
            shape: t.shape, label: t.label, x: t.x, y: t.y,
            w: t.w, d: t.d, z: t.z, height: t.height, rot: t.rot, key: t.key
        };
    }

    function findTableByKey(key) {
        for (var i = 0; i < tableEls.length; i++) {
            if (ensureTableKey(tableEls[i]._tt) === key) { return tableEls[i]; }
        }
        return null;
    }

    function tableSnapshot() {
        return tableEls.map(function (el) {
            var t = el._tt;
            return {
                key: ensureTableKey(t), id: t.id, objectType: t.objectType || "TABLE",
                shape: t.shape, label: t.label,
                x: t.x, y: t.y, w: t.w, d: t.d, z: t.z, height: t.height, rot: t.rot,
                selected: el === tableSel
            };
        });
    }

    function tablePayload() {
        return tableEls.map(function (el) {
            var t = el._tt;
            return {
                id: t.id,
                objectType: t.objectType || "TABLE",
                shape: t.shape,
                label: t.label ? t.label : null,
                layoutX: t.x,
                layoutY: t.y,
                layoutZ: t.z,
                rotationDegrees: t.rot,
                layoutWidth: t.w,
                layoutDepth: t.d,
                objectHeight: t.height
            };
        });
    }

    function makeTableEl(tt) {
        var el = document.createElement("span");
        el._tt = tt;
        el._tt.objectType = OBJECT_TYPES[el._tt.objectType] ? el._tt.objectType : "TABLE";
        if (el._tt.objectType === "SCREEN") { el._tt.shape = "RECTANGLE"; }
        ensureTableKey(el._tt);
        el.addEventListener("pointerdown", onTablePointerDown);
        canvas.appendChild(el);
        tableEls.push(el);
        renderTable(el);
        return el;
    }

    function restoreTables() {
        tableEls.forEach(function (el) { el.remove(); });
        tableEls = [];
        tableSel = null;
        savedTables.forEach(function (st) { makeTableEl(copyTable(st)); });
        refreshTableInspector();
    }

    function rebuildTablesFromResponse(hall) {
        tableEls.forEach(function (el) { el.remove(); });
        tableEls = [];
        tableSel = null;
        (hall.layoutObjects || []).forEach(function (o) {
            var objectType = OBJECT_TYPES[o.objectType] ? o.objectType : "TABLE";
            var shape = objectType === "SCREEN"
                ? "RECTANGLE"
                : (TABLE_SHAPES[o.shape] ? o.shape : "SQUARE");
            var def = objectType === "SCREEN" ? SCREEN_DEF : T_DEF[shape];
            makeTableEl({
                id: o.id,
                objectType: objectType,
                shape: shape,
                label: o.label || "",
                x: Math.max(0, int(o.layoutX, 0)),
                y: Math.max(0, int(o.layoutY, 0)),
                w: clamp(int(o.layoutWidth, def.w), T_MIN, T_MAX),
                d: clamp(int(o.layoutDepth, def.d), T_MIN, T_MAX),
                z: clamp(int(o.layoutZ, def.z || 0), 0, T_Z_MAX),
                height: clamp(int(o.objectHeight, def.height || 40), T_H_MIN, T_H_MAX),
                rot: clamp(int(o.rotationDegrees, 0), -180, 180)
            });
        });
        savedTables = tableEls.map(function (el) { return copyTable(el._tt); });
        refreshTableInspector();
    }

    // --- Portable JSON import / export ---------------------------------------
    var LAYOUT_FILE_SCHEMA = "event-ticketing.hall-layout";
    var LAYOUT_FILE_VERSION = 1;
    var MAX_IMPORT_BYTES = 5 * 1024 * 1024;
    var MAX_IMPORT_SEATS = 5000;
    var MAX_IMPORT_TABLES = 1000;
    var MAX_IMPORT_SECTIONS = 500;

    function exportLayoutJson() {
        var sections = window.HallSectionEditor && window.HallSectionEditor.serialize
            ? window.HallSectionEditor.serialize()
            : [];
        var payload = {
            schema: LAYOUT_FILE_SCHEMA,
            schemaVersion: LAYOUT_FILE_VERSION,
            sourceHallId: hallId,
            exportedAt: new Date().toISOString(),
            layoutWidth: W,
            layoutHeight: H,
            seats: chips.map(function (el) {
                var s = el._st;
                return {
                    id: s.id,
                    label: s.label,
                    rowLabel: s.rowLabel,
                    rowIndex: s.r,
                    seatNumber: s.c,
                    layoutX: s.x,
                    layoutY: s.y,
                    layoutWidth: s.w,
                    layoutHeight: s.h,
                    rotationDegrees: s.rot,
                    sectionName: s.section || null,
                    sectionKey: s.sectionKey || ""
                };
            }),
            layoutObjects: tablePayload(),
            sections: sections
        };
        var blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json"
        });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href = url;
        link.download = "hall-layout-" + (hallId != null ? hallId : "export") + ".json";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        statusEl.textContent = "Layout JSON exported.";
        statusEl.className = "layout-status saved";
    }

    function importNumber(value, field, min, max) {
        var parsed = Number(value);
        if (!isFinite(parsed) || parsed < min || parsed > max) {
            throw new Error(field + " must be between " + min + " and " + max + ".");
        }
        return Math.round(parsed);
    }

    function importOptionalId(value) {
        if (value == null || value === "") { return null; }
        var parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    function normalizeImportedLayout(raw) {
        if (!raw || typeof raw !== "object") {
            throw new Error("The selected file does not contain a layout.");
        }
        if (raw.schema !== LAYOUT_FILE_SCHEMA || raw.schemaVersion !== LAYOUT_FILE_VERSION) {
            throw new Error("Unsupported layout JSON format or version.");
        }
        if (!Array.isArray(raw.seats) || !raw.seats.length) {
            throw new Error("A hall layout must contain at least one seat.");
        }
        if (raw.seats.length > MAX_IMPORT_SEATS) {
            throw new Error("The layout contains too many seats.");
        }

        var labels = Object.create(null);
        var seats = raw.seats.map(function (item, index) {
            var at = "Seat " + (index + 1);
            var label = typeof item.label === "string" ? item.label.trim() : "";
            if (!label) { throw new Error(at + " needs a label."); }
            if (labels[label]) { throw new Error("Duplicate seat label: " + label + "."); }
            labels[label] = true;
            return {
                id: importOptionalId(item.id),
                label: label,
                rowLabel: typeof item.rowLabel === "string" && item.rowLabel.trim()
                    ? item.rowLabel.trim()
                    : letter(importNumber(item.rowIndex, at + " row", 1, 100000)),
                r: importNumber(item.rowIndex, at + " row", 1, 100000),
                c: importNumber(item.seatNumber, at + " number", 1, 100000),
                x: importNumber(item.layoutX, at + " X", 0, 1000000),
                y: importNumber(item.layoutY, at + " Y", 0, 1000000),
                w: importNumber(item.layoutWidth, at + " width", MIN_SEAT_SIZE, MAX_SEAT_SIZE),
                h: importNumber(item.layoutHeight, at + " height", MIN_SEAT_SIZE, MAX_SEAT_SIZE),
                rot: importNumber(item.rotationDegrees, at + " rotation", -180, 180),
                section: typeof item.sectionName === "string" ? item.sectionName : "",
                sectionKey: typeof item.sectionKey === "string" ? item.sectionKey : undefined
            };
        });

        var rawTables = Array.isArray(raw.layoutObjects) ? raw.layoutObjects : [];
        if (rawTables.length > MAX_IMPORT_TABLES) {
            throw new Error("The layout contains too many objects.");
        }
        var tables = rawTables.map(function (item, index) {
            var objectType = OBJECT_TYPES[item.objectType] ? item.objectType : "TABLE";
            var at = (objectType === "SCREEN" ? "Screen " : "Table ") + (index + 1);
            var shape = objectType === "SCREEN"
                ? "RECTANGLE"
                : (TABLE_SHAPES[item.shape] ? item.shape : "SQUARE");
            var width = importNumber(item.layoutWidth, at + " width", T_MIN, T_MAX);
            var depth = importNumber(item.layoutDepth, at + " depth", T_MIN, T_MAX);
            if (shape !== "RECTANGLE") { depth = width; }
            return {
                id: importOptionalId(item.id),
                objectType: objectType,
                shape: shape,
                label: typeof item.label === "string" ? item.label : "",
                x: importNumber(item.layoutX, at + " X", 0, 1000000),
                y: importNumber(item.layoutY, at + " Y", 0, 1000000),
                w: width,
                d: depth,
                z: importNumber(item.layoutZ, at + " elevation", 0, T_Z_MAX),
                height: importNumber(item.objectHeight, at + " height", T_H_MIN, T_H_MAX),
                rot: importNumber(item.rotationDegrees, at + " rotation", -180, 180)
            };
        });

        var rawSections = Array.isArray(raw.sections) ? raw.sections : [];
        if (rawSections.length > MAX_IMPORT_SECTIONS) {
            throw new Error("The layout contains too many sections.");
        }
        var sectionNames = Object.create(null);
        var sectionKeys = new Set();
        var seatedSectionKeys = new Set();
        var sections = rawSections.map(function (item, index) {
            var at = "Section " + (index + 1);
            var name = typeof item.name === "string" ? item.name.trim() : "";
            if (!name) { throw new Error(at + " needs a name."); }
            if (sectionNames[name]) { throw new Error("Duplicate section name: " + name + "."); }
            sectionNames[name] = true;
            var clientKey = typeof item.clientKey === "string" ? item.clientKey : undefined;
            if (clientKey && sectionKeys.has(clientKey)) { throw new Error("Duplicate section reference."); }
            if (clientKey) {
                sectionKeys.add(clientKey);
                if (item.bookingMode !== "GENERAL_ADMISSION") { seatedSectionKeys.add(clientKey); }
            }
            var points = Array.isArray(item.points) ? item.points : [];
            if (points.length > 2000) { throw new Error(at + " has too many boundary points."); }
            var mode = item.bookingMode === "GENERAL_ADMISSION"
                ? "GENERAL_ADMISSION"
                : "SEATED";
            var capacity = item.capacity == null ? null
                : importNumber(item.capacity, at + " capacity", 1, 10000000);
            if (mode === "GENERAL_ADMISSION" && capacity == null) {
                throw new Error(at + " needs a capacity for general admission.");
            }
            return {
                id: importOptionalId(item.id),
                name: name,
                clientKey: clientKey,
                serviceFeePerTicket: item.serviceFeePerTicket,
                bookingMode: mode,
                currency: typeof item.currency === "string" ? item.currency : null,
                capacity: capacity,
                shapeKind: typeof item.shapeKind === "string" ? item.shapeKind : "POLYGON",
                color: typeof item.color === "string" ? item.color : null,
                points: points.map(function (point, pointIndex) {
                    var x = Array.isArray(point) ? point[0] : point.x;
                    var y = Array.isArray(point) ? point[1] : point.y;
                    return {
                        x: importNumber(x, at + " point " + (pointIndex + 1) + " X", 0, 1000000),
                        y: importNumber(y, at + " point " + (pointIndex + 1) + " Y", 0, 1000000)
                    };
                })
            };
        });

        if (seats.some(function (seat) { return seat.sectionKey && !seatedSectionKeys.has(seat.sectionKey); })) {
            throw new Error("The layout references a missing or non-seated section.");
        }

        return {
            sourceHallId: importOptionalId(raw.sourceHallId),
            width: importNumber(raw.layoutWidth, "Layout width", 320, 12000),
            height: importNumber(raw.layoutHeight, "Layout height", 240, 12000),
            seats: seats,
            tables: tables,
            sections: sections
        };
    }

    function replaceWithImportedLayout(layout) {
        if (window.HallSectionEditor && window.HallSectionEditor.hasOverlappingSections(layout.sections)) {
            throw new Error("The imported layout contains overlapping sections.");
        }
        var sameHall = hallId != null && layout.sourceHallId === hallId;
        var existingSeatIds = Object.create(null);
        var existingTableIds = Object.create(null);
        chips.forEach(function (el) {
            if (el._st.id != null) { existingSeatIds[el._st.id] = true; }
        });
        tableEls.forEach(function (el) {
            if (el._tt.id != null) { existingTableIds[el._tt.id] = true; }
        });

        setSelection([]);
        clearTableSelection();
        setCanvasSize(layout.width, layout.height);

        var importedSectionKeys = new Map();
        if (window.HallSectionEditor && window.HallSectionEditor.replaceAll) {
            importedSectionKeys = window.HallSectionEditor.replaceAll(layout.sections, {
                preserveIds: sameHall,
                silent: true
            });
        } else if (layout.sections.length) {
            throw new Error("The section editor is not ready. Reload the page and try again.");
        }

        chips.forEach(function (el) { el.remove(); });
        chips = [];
        var created = createChips(layout.seats.map(function (seat) {
            var state = copy(seat);
            if (seat.sectionKey) { state.sectionKey = importedSectionKeys.get(seat.sectionKey); }
            state.id = sameHall && state.id != null && existingSeatIds[state.id]
                ? state.id
                : null;
            state.key = null;
            return state;
        }));

        tableEls.forEach(function (el) { el.remove(); });
        tableEls = [];
        tableSel = null;
        layout.tables.forEach(function (table) {
            var state = copyTable(table);
            state.id = sameHall && state.id != null && existingTableIds[state.id]
                ? state.id
                : null;
            state.key = null;
            makeTableEl(state);
            ensureTableFits(state);
        });

        ensureCanvasFits(created.map(function (el) { return el._st; }));
        structureChanged = true;
        setSelection([]);
        refreshTableInspector();
        markDirty();
        statusEl.textContent = "Imported " + created.length + " seats, " +
            tableEls.length + " objects, and " + layout.sections.length +
            " sections. Review the layout, then save.";
        statusEl.className = "layout-status dirty";
    }

    function importLayoutFile(file) {
        if (!file) { return; }
        if (file.size > MAX_IMPORT_BYTES) {
            statusEl.textContent = "Import failed: the JSON file is larger than 5 MB.";
            statusEl.className = "layout-status error-text";
            return;
        }
        var reader = new FileReader();
        reader.onload = function () {
            try {
                var layout = normalizeImportedLayout(JSON.parse(String(reader.result || "")));
                if (!window.confirm(
                    "Replace the current editor layout with this JSON file? " +
                    "Nothing is saved until you press Save layout."
                )) {
                    return;
                }
                replaceWithImportedLayout(layout);
            } catch (error) {
                statusEl.textContent = "Import failed: " + shorten(error.message || "Invalid JSON.");
                statusEl.className = "layout-status error-text";
            }
        };
        reader.onerror = function () {
            statusEl.textContent = "Import failed: the file could not be read.";
            statusEl.className = "layout-status error-text";
        };
        reader.readAsText(file);
    }

    if (btnExportLayout) { btnExportLayout.addEventListener("click", exportLayoutJson); }
    if (btnImportLayout && layoutImportFile) {
        btnImportLayout.addEventListener("click", function () {
            if (editing) { layoutImportFile.click(); }
        });
        layoutImportFile.addEventListener("change", function () {
            var file = layoutImportFile.files && layoutImportFile.files[0];
            layoutImportFile.value = "";
            importLayoutFile(file);
        });
    }

    // --- Mode switching ------------------------------------------------------
    function setEditing(on) {
        editing = on;
        canvas.classList.toggle("editing", on);
        btnEdit.classList.toggle("hidden", on);
        btnSave.classList.toggle("hidden", !on);
        btnCancel.classList.toggle("hidden", !on);
        if (btnImportLayout) { btnImportLayout.classList.toggle("hidden", !on); }
        tools.classList.toggle("hidden", !on);
        if (bulkGridTools) { bulkGridTools.classList.toggle("hidden", !on); }
        if (canvasSizeTools) { canvasSizeTools.classList.toggle("hidden", !on); }
        if (tableTools) { tableTools.classList.toggle("hidden", !on); }
        refreshArrangeTools();
        hintEl.textContent = "";
        if (!on) {
            if (marquee) { cleanupMarquee(); }
            setSelection([]);
            clearTableSelection();
        }
        refreshTableInspector();
        notifyBridge("mode");
    }

    function markDirty() {
        statusEl.textContent = "Unsaved changes";
        statusEl.className = "layout-status dirty";
        refreshGridCapacity();
        notifyBridge("change");
    }

    btnEdit.addEventListener("click", function () {
        setEditing(true);
        statusEl.textContent = "";
        statusEl.className = "layout-status";
    });

    btnCancel.addEventListener("click", function () {
        if (structureChanged) {
            // Seats were added/removed — reload to restore the saved server state.
            window.location.reload();
            return;
        }
        chips.forEach(function (el, i) {
            el._st = copy(savedState[i]);
            render(el);
        });
        restoreTables();
        setCanvasSize(savedCanvas.width, savedCanvas.height);
        setEditing(false);
        statusEl.textContent = "";
        statusEl.className = "layout-status";
    });

    // --- Save ----------------------------------------------------------------
    function validateSeatPlacements() {
        var editor = window.HallSectionEditor;
        if (!editor) { return []; }
        var polygons = new Map(editor.getSections().filter(function (section) {
            return section.mode === "SEATED";
        }).map(function (section) { return [section.key, { polygon: section.points }]; }));
        return chips.filter(function (el) {
            var seat = el._st;
            var bounds = polygons.get(seat.sectionKey);
            var invalid = !!seat.sectionKey && (!bounds || !seatFitsSection(seat, seat.x, seat.y, bounds));
            el.classList.toggle("seat-placement-invalid", editing && invalid);
            return invalid;
        });
    }

    btnSave.addEventListener("click", function () {
        if (window.HallSectionEditor && window.HallSectionEditor.hasOverlappingSections()) {
            statusEl.textContent = "Separate overlapping sections before saving.";
            statusEl.className = "layout-status error-text";
            return;
        }
        var invalid = validateSeatPlacements();
        if (invalid.length) {
            statusEl.textContent = invalid.length + " seat(s) outside their assigned sections. First: " + invalid[0]._st.label + ".";
            statusEl.className = "layout-status error-text";
            return;
        }
        var payload = {
            layoutWidth: W,
            layoutHeight: H,
            seats: chips.map(function (el) {
                var s = el._st;
                return {
                    id: s.id,
                    label: s.label,
                    rowLabel: s.rowLabel,
                    rowIndex: s.r,
                    seatNumber: s.c,
                    layoutX: s.x,
                    layoutY: s.y,
                    rotationDegrees: s.rot,
                    layoutWidth: s.w,
                    layoutHeight: s.h,
                    sectionName: s.section ? s.section : null,
                    sectionKey: s.sectionKey || ""
                };
            }),
            layoutObjects: tablePayload(),
            sections: window.HallSectionEditor ? window.HallSectionEditor.serialize() : null
        };

        var headers = { "Content-Type": "application/json" };
        var tokenMeta = document.querySelector('meta[name="_csrf"]');
        var headerMeta = document.querySelector('meta[name="_csrf_header"]');
        if (tokenMeta && headerMeta && tokenMeta.content && headerMeta.content) {
            headers[headerMeta.content] = tokenMeta.content;
        }

        statusEl.textContent = "Saving…";
        statusEl.className = "layout-status";
        btnSave.disabled = true;

        fetch(seatsUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload)
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (t) { throw new Error(t || ("HTTP " + res.status)); });
            }
            return res.json();
        }).then(function (hall) {
            // New seats now have server IDs — match them back by label so further edits update
            // (rather than duplicate) them.
            var idByLabel = {};
            (hall.seats || []).forEach(function (s) { idByLabel[s.label] = s; });
            chips.forEach(function (el) {
                var saved = idByLabel[el._st.label];
                if (saved) {
                    var id = saved.id;
                    el._st.sectionKey = saved.sectionId == null ? "" : "section:" + saved.sectionId;
                    el._st.section = saved.sectionName || "";
                    el._st.id = id;
                    el._st.key = "seat:" + id;
                    el.dataset.id = id;
                }
            });
            rebuildTablesFromResponse(hall);
            if (window.HallSectionEditor) { window.HallSectionEditor.applyServerIds(hall.sections); }
            savedState = chips.map(function (el) { return copy(el._st); });
            savedCanvas = { width: W, height: H };
            structureChanged = false;
            setEditing(false);
            statusEl.textContent = "Saved ✓";
            statusEl.className = "layout-status saved";
            notifyBridge("saved");
        }).catch(function (err) {
            statusEl.textContent = "Save failed: " + shorten(err.message);
            statusEl.className = "layout-status error-text";
        }).then(function () {
            btnSave.disabled = false;
        });
    });

    // --- 2D/3D editor bridge -------------------------------------------------
    function ensureSeatKey(s) {
        if (!s.key) {
            s.key = s.id != null ? "seat:" + s.id : "draft:" + nextDraftKey++;
        }
        return s.key;
    }

    function snapshot() {
        return {
            version: 1,
            width: W,
            height: H,
            editing: editing,
            selectedKeys: selection.map(function (el) { return ensureSeatKey(el._st); }),
            seats: chips.map(function (el) {
                var seat = copy(el._st);
                seat.key = ensureSeatKey(el._st);
                return seat;
            }),
            tables: tableSnapshot(),
            sections: window.HallSectionEditor ? window.HallSectionEditor.getSections() : []
        };
    }

    function notifyBridge(reason) {
        if (!window.HallSeatEditor) { return; }
        var detail = { reason: reason, state: snapshot() };
        bridgeListeners.slice().forEach(function (listener) {
            try { listener(detail.state, reason); } catch (err) { console.error(err); }
        });
        window.dispatchEvent(new CustomEvent("hall-seat-editor-change", { detail: detail }));
    }

    function findByKey(key) {
        for (var i = 0; i < chips.length; i++) {
            if (ensureSeatKey(chips[i]._st) === key) { return chips[i]; }
        }
        return null;
    }

    window.HallSeatEditor = {
        getState: snapshot,
        isEditing: function () { return editing; },
        setEditing: function (on) { setEditing(!!on); },
        ensureLayoutBounds: ensureLayoutBounds,
        extendCanvasLeft: function (pixels) {
            translateContentsX(pixels);
            setCanvasSize(W + pixels, H);
        },
        fitLayoutToContents: fitCanvasToContents,
        validateSeatPlacements: validateSeatPlacements,
        subscribe: function (listener) {
            if (typeof listener !== "function") { return function () {}; }
            bridgeListeners.push(listener);
            listener(snapshot(), "subscribe");
            return function () {
                var index = bridgeListeners.indexOf(listener);
                if (index !== -1) { bridgeListeners.splice(index, 1); }
            };
        },
        select: function (keys) {
            var seen = {};
            var list = (keys || []).map(findByKey).filter(function (el) {
                if (!el) { return false; }
                var key = ensureSeatKey(el._st);
                if (seen[key]) { return false; }
                seen[key] = true;
                return true;
            });
            if (list.length) { clearTableSelection(); }
            setSelection(list);
        },
        // Re-clamps every seat in `sectionName` against SeatBoundsOverride (polygon-aware).
        // Call this on entering the Section Edit view to pull any out-of-shape seats back in.
        clampSeatsInSection: function (sectionName) {
            if (!editing) { return; }
            var want = String(sectionName || "").trim().toLowerCase();
            var moved = false;
            chips.forEach(function (el) {
                var s = el._st;
                if (window.SeatBoundsOverride && window.SeatBoundsOverride.sectionKey
                    ? s.sectionKey !== window.SeatBoundsOverride.sectionKey
                    : String(s.section || "").trim().toLowerCase() !== want) { return; }
                var before = s.x + ":" + s.y;
                clampPosition(el);
                if ((s.x + ":" + s.y) !== before) {
                    moved = true;
                    render(el);
                }
            });
            if (moved) { markDirty(); }
        },
        // Find a complete layout before changing any seats. Count only slots whose full
        // footprint fits, including along concave boundaries.
        fitSeatsInSection: function (count, sectionName) {
            var b = window.SeatBoundsOverride;
            if (!editing || !b || !b.polygon || b.polygon.length < 3) {
                return { error: "Open a section with a valid boundary in the seat editor." };
            }
            if (!Number.isInteger(count) || count < 1 || count > 5000) {
                return { error: "Enter a whole number from 1 to 5,000." };
            }

            var left = Math.max(0, b.left), top = Math.max(0, b.top);
            var width = b.right - left, height = b.bottom - top;
            if (width <= 0 || height <= 0) {
                return { error: "The section needs a boundary with positive width and height." };
            }
            var slots = [], bestCount = 0;
            var size = Math.min(MAX_SEAT_SIZE, Math.floor(Math.sqrt(width * height / count)));
            // Try the minimum even when the bounding rectangle cannot hold the target,
            // so we can report how many slots the fitter found.
            for (size = Math.max(MIN_SEAT_SIZE, size); size >= MIN_SEAT_SIZE; size--) {
                var footprint = { w: size, h: size, rot: 0 };
                var gap = Math.max(1, Math.round(size / 5));
                var step = size + gap;
                var cols = Math.floor((width + gap) / step);
                var rows = Math.floor((height + gap) / step);
                var originX = left + (width - cols * step + gap) / 2;
                var originY = top + (height - rows * step + gap) / 2;
                slots = [];
                for (var ri = 0; ri < rows && slots.length < count; ri++) {
                    for (var ci = 0; ci < cols && slots.length < count; ci++) {
                        var x = Math.round(originX + ci * step);
                        var y = Math.round(originY + ri * step);
                        if (seatFitsSection(footprint, x, y, b)) { slots.push({ x: x, y: y, row: ri }); }
                    }
                }
                if (slots.length === count) { break; }
                bestCount = Math.max(bestCount, slots.length);
            }
            if (slots.length !== count) {
                return { error: "Found " + bestCount + " of " + count
                    + " seats at supported sizes. Existing seats were kept." };
            }

            var wantName = String(sectionName || "").trim().toLowerCase();
            var existing = chips.filter(function (el) {
                return b.sectionKey ? el._st.sectionKey === b.sectionKey
                    : String(el._st.section || "").trim().toLowerCase() === wantName;
            });
            var firstRow = maxRow() + 1;
            var row = -1, seatNumber = 0;
            var states = slots.map(function (slot, i) {
                if (slot.row !== row) { row = slot.row; seatNumber = 0; }
                seatNumber++;
                var rowLabel = letter(firstRow + row);
                var state = existing[i] ? existing[i]._st : {
                    id: null, label: rowLabel + seatNumber, rowLabel: rowLabel,
                    r: firstRow + row, c: seatNumber, section: sectionName || ""
                };
                return Object.assign({}, state, {
                    x: slot.x, y: slot.y, w: size, h: size, rot: 0
                });
            });

            var removed = new Set(existing);
            chips = chips.filter(function (el) { return !removed.has(el); });
            existing.forEach(function (el) { el.remove(); });
            ensureCanvasFits(states);
            afterStructureChange(createChips(states));
            return { created: states.length, seatSize: size };
        },
        getTables: tableSnapshot,
        selectTable: function (key) {
            if (!key) { clearTableSelection(); return; }
            var el = findTableByKey(key);
            if (el) { selectTable(el); }
        },
        applyTablePatch: function (patches, options) {
            if (!editing) { return false; }
            var changed = false;
            var changedStates = [];
            (patches || []).forEach(function (patch) {
                var el = findTableByKey(patch.key);
                if (!el) { return; }
                if (typeof patch.x === "number" && isFinite(patch.x)) {
                    el._tt.x = Math.max(0, Math.round(patch.x));
                    changed = true;
                }
                if (typeof patch.y === "number" && isFinite(patch.y)) {
                    el._tt.y = Math.max(0, Math.round(patch.y));
                    changed = true;
                }
                if (typeof patch.rot === "number" && isFinite(patch.rot)) {
                    el._tt.rot = clamp(Math.round(patch.rot), -180, 180);
                    changed = true;
                }
                renderTable(el);
                changedStates.push(el._tt);
            });
            if (changed) {
                changedStates.forEach(ensureTableFits);
                refreshTableInspector();
                if (!(options && options.transient)) { markDirty(); }
            }
            return changed;
        },
        // Creates seats as unsaved drafts (id: null) — they are persisted by the normal
        // "Save layout" reconcile, so a paste/stamp never needs its own server round-trip.
        // Relative row structure is preserved so labels stay sensible. Returns the new keys, or
        // an empty array when the plan was rejected (e.g. it would overlap existing seats).
        createSeats: function (specs) {
            if (!editing || !specs || !specs.length) { return []; }
            var baseRow = maxRow();
            var rowsSeen = {}, nextRow = 0, colCount = {};
            var states = specs.map(function (sp) {
                var srcRow = sp.r != null ? sp.r : 1;
                if (rowsSeen[srcRow] === undefined) { rowsSeen[srcRow] = baseRow + (++nextRow); }
                var r = rowsSeen[srcRow];
                var rl = letter(r);
                // Seats land in fresh rows, so numbering restarts per row within this batch.
                colCount[r] = (colCount[r] || 0) + 1;
                var c = colCount[r];
                return {
                    id: null, label: rl + c, rowLabel: rl, r: r, c: c,
                    x: Math.round(sp.x), y: Math.round(sp.y),
                    w: clamp(int(sp.w, DEF_W), MIN_SEAT_SIZE, MAX_SEAT_SIZE),
                    h: clamp(int(sp.h, DEF_H), MIN_SEAT_SIZE, MAX_SEAT_SIZE),
                    rot: clamp(int(sp.rot, 0), -180, 180),
                    section: sp.section || ""
                };
            });
            // Persisted blocks own their relative geometry. Keep that geometry
            // intact while checking each seat against the current hall.
            var added = commitSeatPlan(states, "the pasted seats", {
                preserveInternalLayout: true
            });
            return added.map(function (el) { return ensureSeatKey(el._st); });
        },
        createTables: function (specs) {
            if (!editing || !specs || !specs.length) { return []; }
            var made = [];
            specs.forEach(function (sp) {
                var objectType = OBJECT_TYPES[sp.objectType] ? sp.objectType : "TABLE";
                var shape = objectType === "SCREEN"
                    ? "RECTANGLE"
                    : (TABLE_SHAPES[sp.shape] ? sp.shape : "SQUARE");
                var def = objectType === "SCREEN" ? SCREEN_DEF : (T_DEF[shape] || T_DEF.SQUARE);
                var el = document.createElement("span");
                el._tt = {
                    id: null,
                    objectType: objectType,
                    shape: shape,
                    label: sp.label || "",
                    x: Math.max(0, Math.round(sp.x)),
                    y: Math.max(0, Math.round(sp.y)),
                    w: int(sp.w, def.w), d: int(sp.d, def.d),
                    z: int(sp.z, def.z || 0), height: int(sp.height, def.height || 40),
                    rot: clamp(int(sp.rot, 0), -180, 180)
                };
                ensureTableKey(el._tt);
                el.addEventListener("pointerdown", onTablePointerDown);
                canvas.appendChild(el);
                tableEls.push(el);
                renderTable(el);
                ensureTableFits(el._tt);
                made.push(el._tt.key);
            });
            if (made.length) { structureChanged = true; markDirty(); }
            return made;
        },
        applySeatSectionPatch: function (patches, options) {
            if (!editing) { return false; }
            var changed = false;
            (patches || []).forEach(function (patch) {
                var el = findByKey(patch.key);
                if (!el) { return; }
                var section = typeof patch.section === "string" ? patch.section : "";
                if (el._st.section === section && el._st.sectionKey === patch.sectionKey) { return; }
                el._st.section = section;
                el._st.sectionKey = patch.sectionKey;
                changed = true;
            });
            if (changed) {
                refreshInspector();
                if (!(options && options.transient)) { markDirty(); }
            }
            return changed;
        },
        applySpatialPatch: function (patches, options) {
            if (!editing) { return false; }
            var changed = false;
            var changedStates = [];
            (patches || []).forEach(function (patch) {
                var el = findByKey(patch.key);
                if (!el) { return; }
                if (typeof patch.x === "number" && isFinite(patch.x)) {
                    el._st.x = Math.round(patch.x);
                    changed = true;
                }
                if (typeof patch.y === "number" && isFinite(patch.y)) {
                    el._st.y = Math.round(patch.y);
                    changed = true;
                }
                if (typeof patch.rot === "number" && isFinite(patch.rot)) {
                    el._st.rot = clamp(Math.round(patch.rot), -180, 180);
                    changed = true;
                }
                clampPosition(el);
                render(el);
                changedStates.push(el._st);
            });
            if (changed) {
                ensureCanvasFits(changedStates);
                refreshInspector();
                if (!(options && options.transient)) { markDirty(); }
            }
            return changed;
        }
    };

    notifyBridge("ready");
    window.dispatchEvent(new CustomEvent("hall-seat-editor-ready"));

    // Section overlay lives in its own module; when it changes, re-publish the snapshot so the
    // 3D view (which subscribes to this bridge) redraws section boundaries.
    window.addEventListener("hall-sections-change", function () { notifyBridge("sections"); });

    // --- helpers -------------------------------------------------------------
    function btnAddRow() { return document.getElementById("btnAddRow"); }
    function btnAddCol() { return document.getElementById("btnAddCol"); }
    function btnAddSeat() { return document.getElementById("btnAddSeat"); }
    function btnDelSeat() { return document.getElementById("btnDelSeat"); }
    function btnDelRow() { return document.getElementById("btnDelRow"); }
    function btnDelCol() { return document.getElementById("btnDelCol"); }

    function on(id, handler) {
        var elm = document.getElementById(id);
        if (elm) { elm.addEventListener("click", handler); }
    }
    function int(v, fallback) { var n = parseInt(v, 10); return isNaN(n) ? fallback : n; }
    function hasVal(v) { return v !== undefined && v !== null && v !== "" && v !== "null"; }
    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
    function roundUp(value, step) { return Math.ceil(value / step) * step; }
    function copy(s) {
        return {
            id: s.id, label: s.label, rowLabel: s.rowLabel, r: s.r, c: s.c,
            x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot, section: s.section,
            key: s.key, sectionKey: s.sectionKey
        };
    }
    function letter(n) {
        var s = "";
        n -= 1;
        do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
        return s;
    }
    function shorten(msg) {
        msg = String(msg || "");
        return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
    }
})();
