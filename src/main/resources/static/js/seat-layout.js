/*
 * Dynamic seat-layout renderer + editor for the admin app.
 *
 * View mode: draws each seat at its stored pixel coordinates, size, rotation and type.
 * Edit mode:
 *   - drag seats to reposition (multiple selected seats move together);
 *   - shift-click to add/remove seats from the selection;
 *   - drag on empty canvas space to marquee-select seats;
 *   - generate collision-checked rectangular seat blocks;
 *   - assign VIP / Premium / Regular, rotation, size and section;
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
    var MAX_BULK_SEATS = 500, CANVAS_GROW_STEP = 120;
    var TYPES = { VIP: 1, PREMIUM: 1, REGULAR: 1 };

    var W = int(canvas.dataset.w, 900);
    var H = int(canvas.dataset.h, 600);
    var seatsUrl = canvas.dataset.seatsUrl;

    canvas.style.width = W + "px";
    canvas.style.height = H + "px";

    var chips = Array.prototype.slice.call(canvas.querySelectorAll(".seat-chip"));

    var btnEdit = document.getElementById("btnEdit");
    var btnSave = document.getElementById("btnSave");
    var btnCancel = document.getElementById("btnCancel");
    var statusEl = document.getElementById("layoutStatus");
    var hintEl = document.getElementById("layoutHint");
    var tools = document.getElementById("layoutTools");
    var bulkGridTools = document.getElementById("bulkGridTools");
    var arrangeTools = document.getElementById("arrangeTools");
    var gridColumns = document.getElementById("gridColumns");
    var gridRows = document.getElementById("gridRows");
    var gridGapX = document.getElementById("gridGapX");
    var gridGapY = document.getElementById("gridGapY");
    var gridFitSummary = document.getElementById("gridFitSummary");
    var btnAddGrid = document.getElementById("btnAddGrid");
    var hall3dHost = document.getElementById("hall3dCanvas");
    var inspector = document.getElementById("inspector");
    var selLabel = document.getElementById("selLabel");
    var typeSeg = document.getElementById("typeSeg");
    var inSection = document.getElementById("inSection");
    var inRotation = document.getElementById("inRotation");
    var rotVal = document.getElementById("rotVal");
    var inWidth = document.getElementById("inWidth");
    var inHeight = document.getElementById("inHeight");
    var typeButtons = Array.prototype.slice.call(typeSeg.querySelectorAll("button"));

    var editing = false;
    var selection = [];
    var primary = null;
    var structureChanged = false; // seats added/removed -> Cancel must reload
    var bridgeListeners = [];
    var nextDraftKey = 1;
    var marquee = null;
    var marqueeFrame = null;

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
            w: clamp(int(el.dataset.w, DEF_W), 12, 120),
            h: clamp(int(el.dataset.h, DEF_H), 12, 120),
            rot: clamp(int(el.dataset.rot, 0), -180, 180),
            section: el.dataset.section || "",
            type: TYPES[el.dataset.type] ? el.dataset.type : "REGULAR"
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
        statusEl.textContent = "New hall — arrange seats, set VIP/Premium, add or remove seats, then Save.";
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
        el.className = "seat-chip " + s.type + (isSelected(el) ? " selected" : "");
        el.textContent = s.label;
        el.title = s.label + " - " + s.type;
    }

    function clampPosition(el) {
        var s = el._st;
        s.x = Math.max(0, s.x);
        s.y = Math.max(0, s.y);
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
        if (!selection.length) { inspector.classList.add("hidden"); return; }
        inspector.classList.remove("hidden");
        selLabel.textContent = selection.length === 1
            ? primary._st.label + "  (" + primary._st.type + ")"
            : selection.length + " seats selected";
        var ref = primary || selection[0];
        inSection.value = ref._st.section;
        inRotation.value = ref._st.rot;
        rotVal.textContent = ref._st.rot;
        inWidth.value = ref._st.w;
        inHeight.value = ref._st.h;
        highlightType(ref._st.type);
    }
    function highlightType(type) {
        typeButtons.forEach(function (b) { b.classList.toggle("active", b.dataset.type === type); });
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
        if (!isSelected(el)) { setSelection([el]); }
        else { primary = el; refreshInspector(); }

        var rect = canvas.getBoundingClientRect();
        var scaleX = rect.width / W || 1;
        var scaleY = rect.height / H || 1;
        var startX = e.clientX, startY = e.clientY;
        var moving = selection.map(function (s) { return { el: s, ox: s._st.x, oy: s._st.y }; });

        el.setPointerCapture(e.pointerId);
        function move(ev) {
            var dx = (ev.clientX - startX) / scaleX;
            var dy = (ev.clientY - startY) / scaleY;
            moving.forEach(function (m) {
                m.el._st.x = Math.round(m.ox + dx);
                m.el._st.y = Math.round(m.oy + dy);
                clampPosition(m.el);
                render(m.el);
            });
            ensureCanvasFits(moving.map(function (m) { return m.el._st; }));
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
    typeButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
            var t = btn.dataset.type;
            applyToSelection(function (el) { el._st.type = t; });
            highlightType(t);
            if (selection.length === 1) { selLabel.textContent = primary._st.label + "  (" + t + ")"; }
        });
    });
    inSection.addEventListener("input", function () {
        var v = inSection.value.trim();
        applyToSelection(function (el) { el._st.section = v; });
    });
    inRotation.addEventListener("input", function () {
        var v = clamp(int(inRotation.value, 0), -180, 180);
        rotVal.textContent = v;
        applyToSelection(function (el) { el._st.rot = v; });
    });
    inWidth.addEventListener("change", function () {
        var v = clamp(int(inWidth.value, DEF_W), 12, 120);
        inWidth.value = v;
        applyToSelection(function (el) { el._st.w = v; clampPosition(el); });
    });
    inHeight.addEventListener("change", function () {
        var v = clamp(int(inHeight.value, DEF_H), 12, 120);
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
        el._st = st;
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
            type: source ? source.type : "REGULAR",
            section: source ? source.section : ""
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
            type: template.type,
            section: template.section
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
        refreshGridCapacity();
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

    function validateSeatPlan(states, context) {
        if (!states.length) { return "Nothing to add."; }

        var stage = stageReservedRect();
        var existing = chips.map(function (el) {
            return inflateRect(stateBounds(el._st), PLACEMENT_CLEARANCE / 2);
        });
        var planned = [];

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
            if (planned.some(function (other) { return rectsOverlap(padded, other); })) {
                return "The requested spacing is too small for " + context + ".";
            }
            planned.push(padded);
        }
        return null;
    }

    function commitSeatPlan(states, context) {
        var issue = validateSeatPlan(states, context);
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
                    type: spec.type
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
                section: template.section, type: template.type
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
                section: source.section, type: source.type
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
            section: template.section, type: template.type
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
    function median(nums) {
        var a = nums.slice().sort(function (x, y) { return x - y; });
        var m = Math.floor(a.length / 2);
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }

    // Align: with one seat selected, aligns it relative to the whole canvas; with several,
    // aligns them relative to the selection's bounding box.
    function alignSelection(kind) {
        if (!requireSel(1)) { return; }
        var left, right, top, bottom, cX, cY;
        if (selection.length === 1) {
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
        afterArrange();
    }
    on("alLeft", function () { alignSelection("left"); });
    on("alRight", function () { alignSelection("right"); });
    on("alTop", function () { alignSelection("top"); });
    on("alBottom", function () { alignSelection("bottom"); });
    on("alCenterX", function () { alignSelection("centerX"); });
    on("alMiddle", function () { alignSelection("middleY"); });
    on("distH", function () {
        if (!requireSel(3)) { return; }
        var cs = centersOf(selection).sort(function (a, b) { return a.cx - b.cx; });
        var first = cs[0].cx, last = cs[cs.length - 1].cx;
        var step = (last - first) / (cs.length - 1);
        cs.forEach(function (o, i) { setCenter(o.el, first + step * i, o.cy); });
        afterArrange();
    });
    on("distV", function () {
        if (!requireSel(3)) { return; }
        var cs = centersOf(selection).sort(function (a, b) { return a.cy - b.cy; });
        var first = cs[0].cy, last = cs[cs.length - 1].cy;
        var step = (last - first) / (cs.length - 1);
        cs.forEach(function (o, i) { setCenter(o.el, o.cx, first + step * i); });
        afterArrange();
    });
    // Snap each selected seat under its column (median X of same seatNumber) and onto its
    // row (median Y of same rowIndex) — lines a stray row up with the rest of the grid.
    on("snapGrid", function () {
        if (!requireSel(1)) { return; }
        var colX = {}, rowY = {};
        chips.forEach(function (el) {
            var cx = el._st.x + el._st.w / 2, cy = el._st.y + el._st.h / 2;
            (colX[el._st.c] = colX[el._st.c] || []).push(cx);
            (rowY[el._st.r] = rowY[el._st.r] || []).push(cy);
        });
        selection.forEach(function (el) {
            setCenter(el, median(colX[el._st.c]), median(rowY[el._st.r]));
        });
        afterArrange();
    });
    on("straighten", function () {
        if (!requireSel(1)) { return; }
        selection.forEach(function (e) { e._st.rot = 0; });
        afterArrange();
    });
    // Rotate the whole selection as one rigid body around its centroid.
    function rotateGroup(theta) {
        if (!requireSel(1)) { return; }
        var cs = centersOf(selection);
        var ox = cs.reduce(function (s, o) { return s + o.cx; }, 0) / cs.length;
        var oy = cs.reduce(function (s, o) { return s + o.cy; }, 0) / cs.length;
        var rad = theta * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        cs.forEach(function (o) {
            var dx = o.cx - ox, dy = o.cy - oy;
            setCenter(o.el, ox + dx * cos - dy * sin, oy + dx * sin + dy * cos);
            o.el._st.rot = clamp(Math.round(o.el._st.rot + theta), -180, 180);
        });
        afterArrange();
    }
    function groupStep() { return clamp(int(document.getElementById("groupRotStep").value, 15), 1, 180); }
    on("rotCCW", function () { rotateGroup(-groupStep()); });
    on("rotCW", function () { rotateGroup(groupStep()); });

    // Bow the selected seats along a parabola. Up/Down curve a horizontal row (offsets Y);
    // Left/Right curve a vertical column (offsets X). The ends stay put; the middle bows out.
    function curveSelection(axis, sign) {
        if (!requireSel(3)) { return; }
        var amount = clamp(int(document.getElementById("curveAmt").value, 40), 1, 400);
        var cs = centersOf(selection);
        if (axis === "y") {
            cs.sort(function (a, b) { return a.cx - b.cx; });
            var baseY = cs.reduce(function (s, o) { return s + o.cy; }, 0) / cs.length;
            cs.forEach(function (o, i) {
                var t = (i / (cs.length - 1)) * 2 - 1;      // -1 … +1 across the row
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
        afterArrange();
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
    var TABLE_SHAPES = { SQUARE: 1, RECTANGLE: 1, CIRCLE: 1 };
    var T_MIN = 20, T_MAX = 600, T_H_MIN = 6, T_H_MAX = 300, T_Z_MAX = 400;
    var T_DEF = {
        SQUARE: { w: 90, d: 90 },
        RECTANGLE: { w: 150, d: 84 },
        CIRCLE: { w: 104, d: 104 }
    };
    var tableEls = [];
    var tableSel = null;
    var nextTableDraft = 1;
    var savedTables = [];

    var tableTools = document.getElementById("tableTools");
    var tableInspector = document.getElementById("tableInspector");
    var tSelLabel = document.getElementById("tSelLabel");
    var tShape = document.getElementById("tShape");
    var tName = document.getElementById("tName");
    var tWidth = document.getElementById("tWidth");
    var tWidthLabel = document.getElementById("tWidthLabel");
    var tLength = document.getElementById("tLength");
    var tLengthField = document.getElementById("tLengthField");
    var tHeight = document.getElementById("tHeight");
    var tElevation = document.getElementById("tElevation");
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
        var shape = TABLE_SHAPES[el.dataset.shape] ? el.dataset.shape : "SQUARE";
        var def = T_DEF[shape];
        var t = {
            id: hasVal(el.dataset.id) ? int(el.dataset.id, null) : null,
            shape: shape,
            label: el.dataset.label && el.dataset.label !== "null" ? el.dataset.label : "",
            x: Math.max(0, int(el.dataset.x, 60)),
            y: Math.max(0, int(el.dataset.y, 60)),
            w: clamp(int(el.dataset.w, def.w), T_MIN, T_MAX),
            d: clamp(int(el.dataset.d, def.d), T_MIN, T_MAX),
            z: clamp(int(el.dataset.z, 0), 0, T_Z_MAX),
            height: clamp(int(el.dataset.height, 40), T_H_MIN, T_H_MAX),
            rot: clamp(int(el.dataset.rot, 0), -180, 180)
        };
        if (shape !== "RECTANGLE") { t.d = t.w; }
        return t;
    }

    function renderTable(el) {
        var t = el._tt;
        if (t.shape !== "RECTANGLE") { t.d = t.w; }
        el.style.left = t.x + "px";
        el.style.top = t.y + "px";
        el.style.width = t.w + "px";
        el.style.height = t.d + "px";
        el.style.transform = "rotate(" + t.rot + "deg)";
        el.className = "table-chip " + t.shape + (el === tableSel ? " selected" : "");
        el.textContent = t.label ? t.label : "Table";
        el.title = (t.label ? t.label + " — " : "") + "Table (" + t.shape.toLowerCase() + ")";
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
        tSelLabel.textContent = (t.label ? t.label : "Table") + "  (" + t.shape.toLowerCase() + ")";
        if (tShape) { tShape.value = t.shape; }
        if (tName) { tName.value = t.label; }
        if (tWidth) { tWidth.value = t.w; }
        if (tLength) { tLength.value = t.d; }
        if (tHeight) { tHeight.value = t.height; }
        if (tElevation) { tElevation.value = t.z; }
        if (tRotation) { tRotation.value = t.rot; }
        if (tRotVal) { tRotVal.textContent = t.rot; }
        applyShapeUiHints(t.shape);
    }

    function applyShapeUiHints(shape) {
        if (tLengthField) { tLengthField.classList.toggle("hidden", shape !== "RECTANGLE"); }
        if (tWidthLabel) {
            tWidthLabel.textContent = shape === "CIRCLE" ? "Diameter (px)"
                : (shape === "SQUARE" ? "Size (px)" : "Width (px)");
        }
    }

    if (tShape) {
        tShape.addEventListener("change", function () {
            if (!tableSel) { return; }
            var t = tableSel._tt;
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

    function addTable(shape) {
        var def = T_DEF[shape] || T_DEF.SQUARE;
        var el = document.createElement("span");
        el._tt = {
            id: null,
            shape: shape,
            label: "",
            x: Math.max(0, Math.round(W / 2 - def.w / 2)),
            y: Math.max(0, Math.round(H / 2 - def.d / 2)),
            w: def.w,
            d: def.d,
            z: 0,
            height: 40,
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
    on("btnAddSquare", function () { addTable("SQUARE"); });
    on("btnAddRect", function () { addTable("RECTANGLE"); });
    on("btnAddCircle", function () { addTable("CIRCLE"); });
    on("btnDelTable", function () {
        if (!tableSel) {
            statusEl.textContent = "Select a table to delete.";
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
            id: t.id, shape: t.shape, label: t.label, x: t.x, y: t.y,
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
                key: ensureTableKey(t), id: t.id, shape: t.shape, label: t.label,
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
                objectType: "TABLE",
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
            var shape = TABLE_SHAPES[o.shape] ? o.shape : "SQUARE";
            makeTableEl({
                id: o.id,
                shape: shape,
                label: o.label || "",
                x: Math.max(0, int(o.layoutX, 0)),
                y: Math.max(0, int(o.layoutY, 0)),
                w: clamp(int(o.layoutWidth, T_DEF[shape].w), T_MIN, T_MAX),
                d: clamp(int(o.layoutDepth, T_DEF[shape].d), T_MIN, T_MAX),
                z: clamp(int(o.layoutZ, 0), 0, T_Z_MAX),
                height: clamp(int(o.objectHeight, 40), T_H_MIN, T_H_MAX),
                rot: clamp(int(o.rotationDegrees, 0), -180, 180)
            });
        });
        savedTables = tableEls.map(function (el) { return copyTable(el._tt); });
        refreshTableInspector();
    }

    // --- Mode switching ------------------------------------------------------
    function setEditing(on) {
        editing = on;
        canvas.classList.toggle("editing", on);
        btnEdit.classList.toggle("hidden", on);
        btnSave.classList.toggle("hidden", !on);
        btnCancel.classList.toggle("hidden", !on);
        tools.classList.toggle("hidden", !on);
        if (bulkGridTools) { bulkGridTools.classList.toggle("hidden", !on); }
        if (tableTools) { tableTools.classList.toggle("hidden", !on); }
        arrangeTools.classList.toggle("hidden", !on);
        hintEl.textContent = on
            ? "Drag to move. Shift-click to select several, then align, distribute, snap to grid, or rotate the group as one. Add tables (non-bookable) from the Tables toolbar."
            : "";
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
    btnSave.addEventListener("click", function () {
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
                    seatType: s.type,
                    layoutX: s.x,
                    layoutY: s.y,
                    rotationDegrees: s.rot,
                    layoutWidth: s.w,
                    layoutHeight: s.h,
                    sectionName: s.section ? s.section : null
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
            (hall.seats || []).forEach(function (s) { idByLabel[s.label] = s.id; });
            chips.forEach(function (el) {
                var id = idByLabel[el._st.label];
                if (id != null) {
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
            x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot, section: s.section, type: s.type,
            key: s.key
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
