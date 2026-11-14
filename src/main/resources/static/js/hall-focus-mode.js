/*
 * Focus mode for the hall editor — Option A, Phase 1.5.
 *
 * When the admin is in Sections mode and picks exactly one section, a right-side inspector
 * slides in with that section's properties. Clicking "Edit seats in this section →" now:
 *   1. Switches to the Seats tab (so the seat tools at the top of the page are active)
 *   2. CSS-zooms the canvas so the chosen section fills the viewport
 *   3. Dims every other section polygon so the focused one stands out
 *   4. Auto-selects every seat in that section
 *   5. Keeps the inspector visible so the admin can still see / edit section properties
 *   6. Puts a "← Back to hall" bar at the top of the canvas
 *
 * CSS transforms don't break the existing editor's coordinate math because getBoundingClientRect()
 * returns the transformed rect — pointer-to-canvas conversion uses the scaled width/height so it
 * maps correctly. Verified against seat-layout.js's toCanvas() and section-layout.js's toCanvas().
 */
(function () {
    "use strict";

    var canvas         = document.getElementById("seatCanvas");
    var shell          = document.getElementById("planView");
    var inspector      = document.getElementById("focusInspector");
    var modeBar        = document.getElementById("focusModeBar");
    if (!canvas || !shell || !inspector || !modeBar) { return; }

    var insName        = document.getElementById("insSectionName");
    var insModePill    = document.getElementById("insModePill");
    var insModeText    = document.getElementById("insModeText");
    var insCapacity    = document.getElementById("insCapacity");
    var insCapField    = document.getElementById("insCapacityField");
    var insColorSwatch = document.getElementById("insColorSwatch");
    var insColorHex    = document.getElementById("insColorHex");
    var insSeatCount   = document.getElementById("insSeatCount");
    var insSeatStats   = document.getElementById("insSeatStats");
    var insEditBtn     = document.getElementById("insEditSeats");
    var insGaNote      = document.getElementById("insGaNote");
    var modeSection    = document.getElementById("focusModeSection");
    var backBtn        = document.getElementById("focusBack");

    var tabSeats    = document.querySelector('.edit-tab[data-tab="1"]');
    var tabSections = document.querySelector('.edit-tab[data-tab="2"]');
    var hallPage    = document.querySelector(".hall-page");
    var layoutPanel = document.querySelector(".layout-panel");

    // IDs of the tool panels we gather into the dedicated-view left sidebar.
    // Order matters — this is the vertical order they appear in.
    var SIDEBAR_PANELS = ["layoutTools", "bulkGridTools", "tableTools", "arrangeTools"];

    // We remember each panel's original parent + next-sibling so we can put
    // everything back exactly where it belonged when the admin exits focus mode.
    var sidebarEl = null;
    var panelHomes = [];

    // State of the current seat-focus jump, or null when in normal hall view.
    // { section, hint (the inline tip DOM), wasEditing (restored on exit) }
    var active = null;

    // --------- selection subscription -------------------------------------
    window.addEventListener("hall-sections-change", refresh);
    setTimeout(refresh, 0);

    function refresh() {
        var editor = window.HallSectionEditor;
        if (!editor || typeof editor.getSelectedSection !== "function") {
            if (!active) { inspector.classList.add("hidden"); }
            return;
        }
        var sec = editor.getSelectedSection();
        if (!sec) {
            // No selection — close inspector only if we're not actively zoomed into a section.
            if (!active) { inspector.classList.add("hidden"); }
            return;
        }
        // If the admin re-selected the same focused section from the outliner, don't trip the UI.
        populateInspector(sec);
        inspector.classList.remove("hidden");
    }

    function populateInspector(sec) {
        insName.textContent = sec.name || "Untitled";

        var isGa = sec.mode === "GENERAL_ADMISSION";
        insModePill.textContent = isGa ? "● General Admission" : "● Seated";
        insModePill.classList.toggle("ga", isGa);
        insModeText.textContent = isGa ? "General Admission" : "Seated";

        if (isGa) {
            insCapField.hidden = false;
            insCapacity.textContent = sec.capacity != null ? sec.capacity : "—";
        } else {
            insCapField.hidden = true;
        }

        var color = sec.color || "#2E75DC";
        insColorSwatch.style.background = color;
        insColorHex.textContent = color.toUpperCase();

        if (isGa) {
            insSeatStats.hidden = true;
            insEditBtn.hidden = true;
            insGaNote.hidden = false;
            clearInspectorHint();
        } else {
            var seatCount = countSeatsInSection(sec);
            insSeatCount.textContent = seatCount;
            insSeatStats.hidden = false;
            insEditBtn.hidden = false;
            insGaNote.hidden = true;

            // Button toggles between "Edit seats" (normal) and "Exit seat focus" (while zoomed).
            if (active && active.section && sameSection(active.section, sec)) {
                insEditBtn.textContent = "← Exit seat focus";
                insEditBtn.classList.add("exit");
                insEditBtn.onclick = exitSeatFocus;
                showInspectorHint();
            } else {
                insEditBtn.textContent = "Edit seats in this section →";
                insEditBtn.classList.remove("exit");
                insEditBtn.onclick = function () { enterSeatFocus(sec, seatCount); };
                clearInspectorHint();
            }
        }
    }

    // --------- enter / exit seat-focus mode -------------------------------
    function enterSeatFocus(sec, seatCount) {
        if (active) { exitSeatFocus(); }

        // Force the seat editor into edit mode. Entering the Section Edit Canvas implies
        // the admin is about to modify seats — otherwise none of the sidebar actions work
        // (fit, delete, add, align). We remember the prior state so exitSeatFocus() can put
        // things back exactly as they were.
        var wasEditing = false;
        if (window.HallSeatEditor && typeof window.HallSeatEditor.isEditing === "function") {
            wasEditing = window.HallSeatEditor.isEditing();
            if (!wasEditing && typeof window.HallSeatEditor.setEditing === "function") {
                try { window.HallSeatEditor.setEditing(true); } catch (e) { /* ignore */ }
            }
        }

        // Switch to the Seats tab — this reveals the +Row/+Column/+Seat/Delete toolbar that
        // seat-layout.js shows when (edit mode) && (tab 1 active). The buttons live above the
        // canvas in the normal page flow, so the admin sees them without scrolling.
        if (tabSeats) { tabSeats.click(); }

        // Auto-select every seat in this section so the admin can act on them immediately
        // (Delete, align, re-group, etc.).
        var keys = seatKeysForSection(sec);
        if (window.HallSeatEditor && typeof window.HallSeatEditor.select === "function") {
            try { window.HallSeatEditor.select(keys); } catch (e) { /* ignore */ }
        }

        // Switch the whole page into dedicated-view mode. CSS hides every chrome element and
        // reflows the layout-panel so the seat tools + canvas + inspector read as a separate
        // section-edit screen.
        if (hallPage) { hallPage.classList.add("is-section-focus"); }

        // Gather the four tool panels (Seats / Grid / Objects / Arrange) into a dedicated
        // left sidebar. We MOVE the DOM nodes (appendChild preserves listeners and internal
        // state) so the existing seat-layout.js handlers keep working untouched — only their
        // visual placement changes.
        buildSidebar(sec);

        // Drop the section polygon as the "active selection" in the section editor. Keeping it
        // selected swallows clicks (section editing is still listening on the canvas) and stops
        // the seat editor from treating seat clicks as the active target. We still visually
        // highlight the focused section with our own `focus-target` CSS class below.
        if (window.HallSectionEditor && typeof window.HallSectionEditor.clearSelection === "function") {
            try { window.HallSectionEditor.clearSelection(); } catch (e) { /* ignore */ }
        }

        // Tag the chosen polygon so the CSS "dim others" rule knows which one to keep bright.
        markFocusTarget(sec);

        // Publish the section's bbox AND polygon as the alignment / clamping frame.
        // seat-layout.js reads this on every alignSelection() and clampPosition() call, so
        // Left/Right/Top/Bottom/Center/Middle keep seats inside the section instead of
        // snapping to canvas edges, and any later drag is clipped to the section polygon.
        setSeatBoundsFromSection(sec);
        // Pull any seats that are currently sitting outside this section's polygon back in.
        reclampSectionSeats(sec);

        // Defer the zoom to the next animation frame so the dedicated-view CSS (which changes
        // the shell's size by hiding the surrounding chrome and the top/left toolbars) has
        // already laid out — otherwise applyZoom would sample stale shell dimensions and the
        // section would end up off-center or clipped.
        requestAnimationFrame(function () {
            applyZoom(sec);
            // Re-tag after zoom in case section-layer rebuilt its polygons during the layout flush.
            markFocusTarget(sec);
        });

        // Show the top mode bar.
        modeSection.textContent = (sec.name || "Untitled") + (seatCount ? "" : " (no seats yet)");
        modeBar.classList.remove("hidden");

        // Keep the inspector visible; the button becomes "Exit seat focus".
        active = { section: sec, wasEditing: wasEditing };
        populateInspector(sec);
    }

    function exitSeatFocus() {
        if (!active) { return; }
        var wasEditing = active.wasEditing;
        clearZoom();
        clearFocusTarget();
        modeBar.classList.add("hidden");
        tearDownSidebar();
        window.SeatBoundsOverride = null;
        if (hallPage) { hallPage.classList.remove("is-section-focus"); }
        // Restore the prior edit-mode state. If the admin opened the dedicated view from a
        // read-only hall view, we turn edit mode OFF on the way out so nothing is left
        // armed by accident.
        if (!wasEditing && window.HallSeatEditor && typeof window.HallSeatEditor.setEditing === "function") {
            try { window.HallSeatEditor.setEditing(false); } catch (e) { /* ignore */ }
        }

        // Drop the auto-selected seats so the user isn't left with 96 chips selected.
        if (window.HallSeatEditor && typeof window.HallSeatEditor.select === "function") {
            try { window.HallSeatEditor.select([]); } catch (e) { /* ignore */ }
        }

        active = null;

        // Return to the Sections tab; our refresh() repopulates the inspector in normal mode.
        if (tabSections) { tabSections.click(); }
        setTimeout(refresh, 0);
    }

    backBtn.addEventListener("click", exitSeatFocus);

    // --------- publish the section bbox as the seat-align / clamp frame ---
    function setSeatBoundsFromSection(sec) {
        if (!sec || !sec.bbox) { window.SeatBoundsOverride = null; return; }
        var bb = sec.bbox;
        window.SeatBoundsOverride = {
            left:   bb.minX,
            right:  bb.maxX,
            top:    bb.minY,
            bottom: bb.maxY,
            polygon: sec.points || null,
            sectionKey: sec.key,
            centroid: polygonCentroid(sec.points)
        };
    }

    function polygonCentroid(points) {
        if (!points || points.length < 3) { return null; }
        // Area-weighted centroid for a simple polygon. Falls back to the bbox center if
        // the polygon degenerates (zero area).
        var a = 0, cx = 0, cy = 0;
        for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
            var p = points[i], q = points[j];
            var cross = q.x * p.y - p.x * q.y;
            a += cross; cx += (q.x + p.x) * cross; cy += (q.y + p.y) * cross;
        }
        if (!a) {
            var sx = 0, sy = 0;
            for (var k = 0; k < points.length; k++) { sx += points[k].x; sy += points[k].y; }
            return { x: sx / points.length, y: sy / points.length };
        }
        a *= 0.5;
        return { x: cx / (6 * a), y: cy / (6 * a) };
    }

    // Walks every seat that belongs to the focused section and re-clamps it inside the
    // polygon. Fixes seats that were placed outside the section by earlier edits and makes
    // "enter focus" feel like it tidied the view.
    function reclampSectionSeats(sec) {
        if (!window.HallSeatEditor) { return; }
        var ed = window.HallSeatEditor;
        if (typeof ed.clampSeatsInSection !== "function") { return; }
        try { ed.clampSeatsInSection(sec.name); } catch (e) { /* ignore */ }
    }

    // --------- dedicated-view sidebar (re-parent tool panels) -------------
    function buildSidebar(sec) {
        if (sidebarEl || !layoutPanel) { return; }
        sidebarEl = document.createElement("div");
        sidebarEl.className = "section-edit-sidebar";
        // Insert just before the canvas shell so the dedicated view's three
        // regions (sidebar / canvas / inspector) are laid out in reading order.
        if (shell && shell.parentNode === layoutPanel) {
            layoutPanel.insertBefore(sidebarEl, shell);
        } else {
            layoutPanel.appendChild(sidebarEl);
        }
        // First tool panel: our own "Auto-fit N seats" box — most interesting action for a
        // big section, so it goes at the very top of the sidebar.
        sidebarEl.appendChild(buildAutoFitPanel(sec));

        panelHomes = [];
        for (var i = 0; i < SIDEBAR_PANELS.length; i++) {
            var el = document.getElementById(SIDEBAR_PANELS[i]);
            if (!el) { continue; }
            panelHomes.push({ el: el, parent: el.parentNode, next: el.nextSibling });
            sidebarEl.appendChild(el);
        }
    }

    function buildAutoFitPanel(sec) {
        var panel = document.createElement("div");
        panel.className = "layout-tools section-autofit-tools";
        panel.innerHTML =
            '<span class="tools-label section-autofit-label">Auto-fit seats</span>' +
            '<label class="compact-field">' +
            '  <span>How many seats?</span>' +
            '  <input type="number" class="section-autofit-count" value="100" min="1" max="5000" step="1">' +
            '</label>' +
            '<button type="button" class="btn small section-autofit-btn">Fit seats in section</button>' +
            '<span class="muted tools-note section-autofit-note">' +
              'Resizes and arranges seats to fit your target count inside the section.' +
            '</span>';
        var btn   = panel.querySelector(".section-autofit-btn");
        var input = panel.querySelector(".section-autofit-count");
        var note  = panel.querySelector(".section-autofit-note");
        btn.addEventListener("click", function () {
            if (!window.HallSeatEditor || typeof window.HallSeatEditor.fitSeatsInSection !== "function") {
                note.textContent = "Seat editor not ready yet.";
                return;
            }
            var result = window.HallSeatEditor.fitSeatsInSection(input.valueAsNumber, sec.name);
            note.textContent = result.error || ("Placed " + result.created + " seats at "
                + result.seatSize + " × " + result.seatSize + " px.");
        });
        return panel;
    }

    function tearDownSidebar() {
        // Put every panel back exactly where it was, then remove the sidebar wrapper.
        for (var i = 0; i < panelHomes.length; i++) {
            var home = panelHomes[i];
            if (!home.parent) { continue; }
            if (home.next && home.next.parentNode === home.parent) {
                home.parent.insertBefore(home.el, home.next);
            } else {
                home.parent.appendChild(home.el);
            }
        }
        panelHomes = [];
        if (sidebarEl && sidebarEl.parentNode) {
            sidebarEl.parentNode.removeChild(sidebarEl);
        }
        sidebarEl = null;
    }

    // --------- zoom --------------------------------------------------------
    var zoomInput = document.getElementById("canvasZoom");
    var zoomReset = document.getElementById("canvasZoomReset");
    var zoomPercent = 100;
    var hallZoom = 100;

    function setZoom(percent, center) {
        percent = Math.max(25, Math.min(1000, Math.round(percent)));
        var viewport = shell.getBoundingClientRect();
        var viewX = viewport.left + shell.clientLeft + shell.clientWidth / 2;
        var viewY = viewport.top + shell.clientTop + shell.clientHeight / 2;
        var before = canvas.getBoundingClientRect();
        var x = center ? center.x : (viewX - before.left) * 100 / zoomPercent;
        var y = center ? center.y : (viewY - before.top) * 100 / zoomPercent;

        zoomPercent = percent;
        canvas.style.zoom = percent / 100;
        zoomInput.value = percent;
        zoomInput.setAttribute("aria-valuetext", percent + "%");
        zoomReset.textContent = percent + "%";
        var after = canvas.getBoundingClientRect();
        shell.scrollLeft += after.left + x * percent / 100 - viewX;
        shell.scrollTop += after.top + y * percent / 100 - viewY;
    }

    zoomInput.addEventListener("input", function () { setZoom(zoomInput.valueAsNumber); });
    document.getElementById("canvasZoomOut").addEventListener("click", function () { setZoom(zoomPercent - 25); });
    document.getElementById("canvasZoomIn").addEventListener("click", function () { setZoom(zoomPercent + 25); });
    zoomReset.addEventListener("click", function () { setZoom(100); });

    function applyZoom(sec) {
        var bb = sec.bbox;
        if (!bb || bb.maxX <= bb.minX || bb.maxY <= bb.minY) { return; }
        hallZoom = zoomPercent;
        var scale = Math.min(shell.clientWidth / (bb.maxX - bb.minX),
            shell.clientHeight / (bb.maxY - bb.minY)) * 0.82;
        shell.classList.add("focus-zoomed");
        setZoom(Math.min(scale, 3.5) * 100, {
            x: (bb.minX + bb.maxX) / 2,
            y: (bb.minY + bb.maxY) / 2
        });
    }

    function clearZoom() {
        shell.classList.remove("focus-zoomed");
        setZoom(hallZoom);
    }


    // --------- highlight the focused section polygon -----------------------
    function markFocusTarget(sec) {
        clearFocusTarget();
        // The section-layer SVG is inserted inside #seatCanvas; its polygons are drawn in the
        // same order as HallSectionEditor.getSections(). We find ours by position attribute match.
        var layer = canvas.querySelector(".section-layer");
        if (!layer) { return; }
        var polys = layer.querySelectorAll("polygon");
        for (var i = 0; i < polys.length; i++) {
            if (polygonMatches(polys[i], sec)) {
                polys[i].classList.add("focus-target");
                return;
            }
        }
    }
    function clearFocusTarget() {
        var layer = canvas.querySelector(".section-layer");
        if (!layer) { return; }
        var polys = layer.querySelectorAll("polygon.focus-target");
        for (var i = 0; i < polys.length; i++) { polys[i].classList.remove("focus-target"); }
    }
    // Compare by points — section polygons are small; a cheap string equality is fine.
    function polygonMatches(poly, sec) {
        var want = (sec.bbox && (sec.bbox.minX + ":" + sec.bbox.minY)) || "";
        if (!want) { return false; }
        var pts = (poly.getAttribute("points") || "").split(/\s+/).filter(Boolean);
        if (!pts.length) { return false; }
        var minX = Infinity, minY = Infinity;
        for (var i = 0; i < pts.length; i++) {
            var xy = pts[i].split(",");
            var x = parseFloat(xy[0]), y = parseFloat(xy[1]);
            if (isFinite(x) && x < minX) { minX = x; }
            if (isFinite(y) && y < minY) { minY = y; }
        }
        return Math.abs(minX - sec.bbox.minX) < 0.5 && Math.abs(minY - sec.bbox.minY) < 0.5;
    }

    // --------- inspector hint --------------------------------------------
    var hintEl = null;
    function showInspectorHint() {
        if (hintEl) { return; }
        var body = inspector.querySelector(".focus-inspector-body");
        if (!body) { return; }
        hintEl = document.createElement("p");
        hintEl.className = "focus-hint";
        hintEl.textContent = "You're inside the Section Edit Canvas. Use the seat toolbar at the "
            + "top (+ Row, + Column, Generate seats) to add or arrange seats. Click ← Back to hall "
            + "or press Esc to return.";
        body.appendChild(hintEl);
    }
    function clearInspectorHint() {
        if (hintEl && hintEl.parentNode) { hintEl.parentNode.removeChild(hintEl); }
        hintEl = null;
    }

    // --------- lock the section as read-only while focused ----------------
    // Inside the Section Edit Canvas the section itself is NOT editable — only its seats
    // and objects. If anything (a stray click, a keyboard shortcut, another script) selects
    // a section while we're in focus mode, drop that selection immediately. The polygon
    // stays visually marked via our own `focus-target` class.
    window.addEventListener("hall-sections-change", function () {
        if (!active) { return; }
        var editor = window.HallSectionEditor;
        if (!editor) { return; }
        var sec = editor.getSelectedSection();
        if (sec && typeof editor.clearSelection === "function") {
            try { editor.clearSelection(); } catch (e) { /* ignore */ }
        }
        // Re-apply the visual focus target in case section-layer rebuilt its polygons.
        markFocusTarget(active.section);
    });

    // --------- helpers ----------------------------------------------------
    function sameSection(a, b) {
        if (!a || !b) { return false; }
        if (a.id != null && b.id != null) { return a.id === b.id; }
        return (a.key && b.key) ? a.key === b.key : (a.name === b.name);
    }

    function countSeatsInSection(sec) {
        if (!window.HallSeatEditor || typeof window.HallSeatEditor.getState !== "function") { return 0; }
        var state;
        try { state = window.HallSeatEditor.getState(); } catch (e) { return 0; }
        if (!state || !state.seats) { return 0; }
        return state.seats.filter(function (q) { return matchesSection(q, sec); }).length;
    }

    function seatKeysForSection(sec) {
        if (!window.HallSeatEditor || typeof window.HallSeatEditor.getState !== "function") { return []; }
        var state;
        try { state = window.HallSeatEditor.getState(); } catch (e) { return []; }
        if (!state || !state.seats) { return []; }
        return state.seats
            .filter(function (q) { return matchesSection(q, sec); })
            .map(function (q) { return q.key; });
    }

    function matchesSection(seatState, sec) {
        if (!seatState) { return false; }
        if (seatState.sectionKey != null) { return seatState.sectionKey === sec.key; }
        if (seatState.section == null) { return false; }
        var name = (sec.name || "").trim().toLowerCase();
        return (String(seatState.section) || "").trim().toLowerCase() === name;
    }

    // Exit focus mode on Escape, as a last-resort keyboard escape hatch.
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && active) {
            e.preventDefault();
            exitSeatFocus();
        }
    });
})();
