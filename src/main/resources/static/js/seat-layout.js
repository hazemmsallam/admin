/*
 * Dynamic seat-layout renderer + editor for the admin app.
 *
 * View mode: draws each seat at its stored pixel coordinates, size, rotation and type.
 * Edit mode:
 *   - drag seats to reposition (multiple selected seats move together);
 *   - shift-click to add/remove seats from the selection;
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
    var arrangeTools = document.getElementById("arrangeTools");
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
        if (!el._st.rowLabel) { el._st.rowLabel = letter(el._st.r); }
        clampPosition(el);
        render(el);
        el.addEventListener("pointerdown", onSeatPointerDown);
    });

    var savedState = chips.map(function (el) { return copy(el._st); });

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
        s.x = clamp(s.x, 0, Math.max(0, W - s.w));
        s.y = clamp(s.y, 0, Math.max(0, H - s.h));
    }

    // --- Selection -----------------------------------------------------------
    function isSelected(el) { return selection.indexOf(el) !== -1; }
    function setSelection(list) {
        selection = list;
        primary = list.length ? list[list.length - 1] : null;
        chips.forEach(render);
        refreshInspector();
    }
    function toggleInSelection(el) {
        var i = selection.indexOf(el);
        if (i === -1) { selection.push(el); primary = el; }
        else { selection.splice(i, 1); primary = selection.length ? selection[selection.length - 1] : null; }
        chips.forEach(render);
        refreshInspector();
    }
    function refreshInspector() {
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
        markDirty();
    }

    // --- Dragging (whole selection) -----------------------------------------
    function onSeatPointerDown(e) {
        if (!editing) { return; }
        e.preventDefault();
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

    canvas.addEventListener("pointerdown", function (e) {
        if (editing && e.target === canvas) { setSelection([]); }
    });

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
    function rowYFor(r) {
        for (var i = 0; i < chips.length; i++) { if (chips[i]._st.r === r) { return chips[i]._st.y; } }
        return START_Y + (r - 1) * GAP_Y;
    }
    function rowTypeFor(r) {
        for (var i = 0; i < chips.length; i++) { if (chips[i]._st.r === r) { return chips[i]._st.type; } }
        return "REGULAR";
    }
    function rowRightX(r) {
        var mx = -Infinity;
        chips.forEach(function (el) { if (el._st.r === r) { mx = Math.max(mx, el._st.x); } });
        return mx === -Infinity ? START_X : mx;
    }
    function maxColInRow(r) {
        return chips.reduce(function (m, el) { return el._st.r === r ? Math.max(m, el._st.c) : m; }, 0);
    }

    function createChip(st) {
        var el = document.createElement("span");
        el._st = st;
        el.addEventListener("pointerdown", onSeatPointerDown);
        canvas.appendChild(el);
        chips.push(el);
        clampPosition(el);
        render(el);
        return el;
    }

    function afterStructureChange(newlySelected) {
        structureChanged = true;
        markDirty();
        setSelection(newlySelected || []);
    }

    btnAddRow().addEventListener("click", function () {
        var newR = maxRow() + 1;
        var cols = maxCol() || 1;
        var rl = letter(newR);
        var added = [];
        for (var c = 1; c <= cols; c++) {
            added.push(createChip({
                id: null, label: rl + c, rowLabel: rl, r: newR, c: c,
                x: START_X + (c - 1) * GAP_X, y: START_Y + (newR - 1) * GAP_Y,
                w: DEF_W, h: DEF_H, rot: 0, section: "", type: "REGULAR"
            }));
        }
        afterStructureChange(added);
    });

    btnAddCol().addEventListener("click", function () {
        var newC = maxCol() + 1;
        var added = [];
        rowsPresent().forEach(function (r) {
            var rl = rowLabelFor(r);
            added.push(createChip({
                id: null, label: rl + newC, rowLabel: rl, r: r, c: newC,
                x: rowRightX(r) + GAP_X, y: rowYFor(r),
                w: DEF_W, h: DEF_H, rot: 0, section: "", type: rowTypeFor(r)
            }));
        });
        afterStructureChange(added);
    });

    btnAddSeat().addEventListener("click", function () {
        var r, rl, type;
        if (primary) { r = primary._st.r; rl = rowLabelFor(r); type = primary._st.type; }
        else { r = maxRow() + 1; rl = letter(r); type = "REGULAR"; }
        var c = maxColInRow(r) + 1;
        var chip = createChip({
            id: null, label: rl + c, rowLabel: rl, r: r, c: c,
            x: rowRightX(r) + GAP_X, y: rowYFor(r),
            w: DEF_W, h: DEF_H, rot: 0, section: "", type: type
        });
        afterStructureChange([chip]);
    });

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

    // --- Mode switching ------------------------------------------------------
    function setEditing(on) {
        editing = on;
        canvas.classList.toggle("editing", on);
        btnEdit.classList.toggle("hidden", on);
        btnSave.classList.toggle("hidden", !on);
        btnCancel.classList.toggle("hidden", !on);
        tools.classList.toggle("hidden", !on);
        arrangeTools.classList.toggle("hidden", !on);
        hintEl.textContent = on
            ? "Drag to move. Shift-click to select several, then align, distribute, snap to grid, or rotate the group as one."
            : "";
        if (!on) { setSelection([]); }
    }

    function markDirty() {
        statusEl.textContent = "Unsaved changes";
        statusEl.className = "layout-status dirty";
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
            })
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
                if (id != null) { el._st.id = id; el.dataset.id = id; }
            });
            savedState = chips.map(function (el) { return copy(el._st); });
            structureChanged = false;
            setEditing(false);
            statusEl.textContent = "Saved ✓";
            statusEl.className = "layout-status saved";
        }).catch(function (err) {
            statusEl.textContent = "Save failed: " + shorten(err.message);
            statusEl.className = "layout-status error-text";
        }).then(function () {
            btnSave.disabled = false;
        });
    });

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
    function copy(s) {
        return {
            id: s.id, label: s.label, rowLabel: s.rowLabel, r: s.r, c: s.c,
            x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot, section: s.section, type: s.type
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
