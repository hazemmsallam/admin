/*
 * Interactive seat-layout builder for the hall CREATE page.
 *
 * Generates neutral seats client-side from rows/columns using the same arc/fan geometry the
 * backend would, then lets the admin drag, resize, rotate and group them before the hall exists.
 * The arrangement is serialised (keyed by row/column) into a hidden field and applied by
 * HallController after the hall and its seat IDs are created.
 *
 * Sibling of seat-layout.js (which edits an existing hall's real seat IDs).
 */
(function () {
    "use strict";

    var canvas = document.getElementById("seatCanvas");
    var builderWrap = document.getElementById("builderWrap");
    if (!canvas || !builderWrap) {
        return;
    }

    var stage = canvas.querySelector(".stage-abs");
    var hidden = document.getElementById("layoutJson");
    var note = document.getElementById("previewNote");
    var hintEl = document.getElementById("layoutHint");
    var inspector = document.getElementById("inspector");
    var selLabel = document.getElementById("selLabel");
    var inSection = document.getElementById("inSection");
    var inRotation = document.getElementById("inRotation");
    var rotVal = document.getElementById("rotVal");
    var inWidth = document.getElementById("inWidth");
    var inHeight = document.getElementById("inHeight");
    var form = canvas.closest("form");

    // Must match the backend HallService constants.
    var SEAT_W = 42, SEAT_H = 38, GAP_X = 58, GAP_Y = 52, START_Y = 150, MAX_SEATS = 800;

    var W = 820, H = 560;
    var chips = [];
    var selection = [];
    var primary = null;

    // Restore a prior arrangement once (e.g. when the form redisplays after a validation error).
    var initialSaved = parseSaved(hidden.value);

    function parseSaved(v) {
        try {
            var arr = JSON.parse(v || "[]");
            if (!Array.isArray(arr) || !arr.length) { return null; }
            var map = {};
            arr.forEach(function (o) { map[o.r + ":" + o.c] = o; });
            return map;
        } catch (e) {
            return null;
        }
    }

    // --- helpers -------------------------------------------------------------
    function el(id) { return document.getElementById(id); }
    function int(v, f) { var n = parseInt(v, 10); return isNaN(n) ? f : n; }
    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
    function numField(id) { var e = el(id); var n = e ? parseInt(e.value, 10) : NaN; return isNaN(n) ? null : n; }
    function isSeated() { var e = el("seated"); return !!(e && e.checked); }

    function rowLabel(n) {
        var s = "";
        n -= 1;
        do {
            s = String.fromCharCode(65 + (n % 26)) + s;
            n = Math.floor(n / 26) - 1;
        } while (n >= 0);
        return s;
    }

    function isSelected(el2) { return selection.indexOf(el2) !== -1; }

    function render(chip) {
        var s = chip._st;
        chip.style.left = s.x + "px";
        chip.style.top = s.y + "px";
        chip.style.width = s.w + "px";
        chip.style.height = s.h + "px";
        chip.style.transform = "rotate(" + s.rot + "deg)";
        chip.className = "seat-chip" + (isSelected(chip) ? " selected" : "");
        chip.title = chip.textContent;
    }

    function clampPos(chip) {
        var s = chip._st;
        s.x = clamp(s.x, 0, Math.max(0, W - s.w));
        s.y = clamp(s.y, 0, Math.max(0, H - s.h));
    }

    function serialize() {
        hidden.value = JSON.stringify(chips.map(function (chip) {
            var s = chip._st;
            return { r: s.r, c: s.c, x: s.x, y: s.y, rot: s.rot, w: s.w, h: s.h, section: s.section };
        }));
    }

    // --- (re)generate seats when dimensions change ---------------------------
    function rebuild() {
        chips.forEach(function (c) { c.remove(); });
        chips = [];
        selection = [];
        primary = null;
        refreshInspector();

        // The whole Seated-layout fieldset is only meaningful for a seated hall.
        var fieldset = document.getElementById("seatedLayoutFieldset");
        if (!isSeated()) {
            if (fieldset) { fieldset.style.display = "none"; }
            builderWrap.style.display = "none";
            serialize();
            return;
        }
        if (fieldset) { fieldset.style.display = "block"; }
        builderWrap.style.display = "block";

        var rows = numField("numRows"), cols = numField("numColumns");
        if (!rows || !cols || rows < 1 || cols < 1) {
            // Rows/columns are optional — the hall can be saved empty and the
            // seats drawn visually in the hall editor afterwards.
            note.textContent = "No seats yet. Enter rows and columns to preview a grid, or leave empty and arrange seats in the hall editor after creation.";
            hintEl.textContent = "";
            if (stage) { stage.style.display = "flex"; }
            canvas.style.width = "820px";
            canvas.style.height = "260px";
            serialize();
            return;
        }
        if (rows * cols > MAX_SEATS) {
            note.textContent = "Too many seats to arrange visually (" + (rows * cols) + "). They'll be generated with the default layout — fine-tune later in the editor.";
            hintEl.textContent = "";
            if (stage) { stage.style.display = "none"; }
            canvas.style.width = "820px";
            canvas.style.height = "200px";
            serialize();
            return;
        }

        if (stage) { stage.style.display = "flex"; }
        note.textContent = "Generated " + (rows * cols) + " seats.";
        hintEl.textContent = "Drag to reposition. Click a seat (shift-click for several) to adjust rotation, size or section.";

        W = Math.max(820, cols * 64 + 360);
        H = Math.max(560, rows * 58 + 270);
        canvas.style.width = W + "px";
        canvas.style.height = H + "px";

        var rowWidth = (cols - 1) * GAP_X + SEAT_W;
        var startX = Math.max(70, Math.floor((W - rowWidth) / 2));
        var center = (cols + 1) / 2;

        var frag = document.createDocumentFragment();
        for (var r = 1; r <= rows; r++) {
            for (var c = 1; c <= cols; c++) {
                var arc = Math.round(Math.pow(c - center, 2) * 1.35);
                var fan = Math.round((r - (rows + 1) / 2) * 3.0);
                var chip = document.createElement("span");
                chip.textContent = rowLabel(r) + c;
                chip._st = {
                    r: r, c: c,
                    x: startX + (c - 1) * GAP_X + fan,
                    y: START_Y + (r - 1) * GAP_Y + arc,
                    w: SEAT_W, h: SEAT_H,
                    rot: Math.trunc(fan / 2),
                    section: ""
                };
                if (initialSaved) {
                    var saved = initialSaved[r + ":" + c];
                    if (saved) {
                        chip._st.x = int(saved.x, chip._st.x);
                        chip._st.y = int(saved.y, chip._st.y);
                        chip._st.w = clamp(int(saved.w, SEAT_W), 12, 120);
                        chip._st.h = clamp(int(saved.h, SEAT_H), 12, 120);
                        chip._st.rot = clamp(int(saved.rot, 0), -180, 180);
                        chip._st.section = saved.section || "";
                    }
                }
                clampPos(chip);
                render(chip);
                chip.addEventListener("pointerdown", onSeatPointerDown);
                frag.appendChild(chip);
                chips.push(chip);
            }
        }
        canvas.appendChild(frag);
        initialSaved = null; // only restore on the first successful build
        serialize();
    }

    // --- selection + inspector ----------------------------------------------
    function setSelection(list) {
        selection = list;
        primary = list.length ? list[list.length - 1] : null;
        chips.forEach(render);
        refreshInspector();
    }
    function toggleInSelection(chip) {
        var i = selection.indexOf(chip);
        if (i === -1) { selection.push(chip); primary = chip; }
        else { selection.splice(i, 1); primary = selection.length ? selection[selection.length - 1] : null; }
        chips.forEach(render);
        refreshInspector();
    }
    function refreshInspector() {
        if (!selection.length) { inspector.classList.add("hidden"); return; }
        inspector.classList.remove("hidden");
        selLabel.textContent = selection.length === 1
            ? primary.textContent
            : selection.length + " seats selected";
        var ref = primary || selection[0];
        inSection.value = ref._st.section;
        inRotation.value = ref._st.rot;
        rotVal.textContent = ref._st.rot;
        inWidth.value = ref._st.w;
        inHeight.value = ref._st.h;
    }
    function applyToSelection(fn) {
        selection.forEach(function (chip) { fn(chip); render(chip); });
        serialize();
    }

    // --- dragging (whole selection) -----------------------------------------
    function onSeatPointerDown(e) {
        e.preventDefault();
        var chip = e.currentTarget;

        if (e.shiftKey) {
            toggleInSelection(chip);
            return;
        }
        if (!isSelected(chip)) { setSelection([chip]); }
        else { primary = chip; refreshInspector(); }

        var rect = canvas.getBoundingClientRect();
        var scaleX = rect.width / W || 1;
        var scaleY = rect.height / H || 1;
        var startX = e.clientX, startY = e.clientY;
        var moving = selection.map(function (s) { return { el: s, ox: s._st.x, oy: s._st.y }; });

        chip.setPointerCapture(e.pointerId);

        function move(ev) {
            var dx = (ev.clientX - startX) / scaleX;
            var dy = (ev.clientY - startY) / scaleY;
            moving.forEach(function (m) {
                m.el._st.x = Math.round(m.ox + dx);
                m.el._st.y = Math.round(m.oy + dy);
                clampPos(m.el);
                render(m.el);
            });
        }
        function up() {
            chip.releasePointerCapture(e.pointerId);
            chip.removeEventListener("pointermove", move);
            chip.removeEventListener("pointerup", up);
            serialize();
        }
        chip.addEventListener("pointermove", move);
        chip.addEventListener("pointerup", up);
    }

    canvas.addEventListener("pointerdown", function (e) {
        if (e.target === canvas) { setSelection([]); }
    });

    // --- inspector controls --------------------------------------------------
    inSection.addEventListener("input", function () {
        var v = inSection.value.trim();
        applyToSelection(function (chip) { chip._st.section = v; });
    });
    inRotation.addEventListener("input", function () {
        var v = clamp(int(inRotation.value, 0), -180, 180);
        rotVal.textContent = v;
        applyToSelection(function (chip) { chip._st.rot = v; });
    });
    inWidth.addEventListener("change", function () {
        var v = clamp(int(inWidth.value, SEAT_W), 12, 120);
        inWidth.value = v;
        applyToSelection(function (chip) { chip._st.w = v; clampPos(chip); });
    });
    inHeight.addEventListener("change", function () {
        var v = clamp(int(inHeight.value, SEAT_H), 12, 120);
        inHeight.value = v;
        applyToSelection(function (chip) { chip._st.h = v; clampPos(chip); });
    });

    // --- wiring --------------------------------------------------------------
    ["numRows", "numColumns", "seated"]
        .forEach(function (id) {
            var e = el(id);
            if (e) {
                e.addEventListener("input", rebuild);
                e.addEventListener("change", rebuild);
            }
        });
    if (form) {
        form.addEventListener("submit", serialize);
    }

    rebuild();
})();
