import * as THREE from "three";
import { OrbitControls } from "/vendor/three/OrbitControls.js";
import { RoundedBoxGeometry } from "/vendor/three/RoundedBoxGeometry.js";

(function () {
    "use strict";

    var host = document.getElementById("hall3dCanvas");
    var editor = window.HallSeatEditor;
    if (!host || !editor) {
        return;
    }

    var planView = document.getElementById("planView");
    var threeView = document.getElementById("threeView");
    var threeToolbar = document.getElementById("threeToolbar");
    var viewPlan = document.getElementById("viewPlan");
    var view3d = document.getElementById("view3d");
    var cameraPerspective = document.getElementById("cameraPerspective");
    var cameraTop = document.getElementById("cameraTop");
    var fitButton = document.getElementById("fit3d");
    var selectionStatus = document.getElementById("threeSelection");

    var PIXELS_PER_METER = 52;
    var SNAP_PIXELS = 4;
    var MAX_LABELS = 250;
    var TYPE_COLORS = {
        VIP: new THREE.Color(0x9a5cf5),
        PREMIUM: new THREE.Color(0x2e75dc),
        REGULAR: new THREE.Color(0x68758a)
    };

    var state = editor.getState();
    var worldWidth = state.width / PIXELS_PER_METER;
    var worldDepth = state.height / PIXELS_PER_METER;
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x161a22);
    scene.fog = new THREE.Fog(0x161a22, 45, 180);
    var hallRoot = new THREE.Group();
    hallRoot.name = "hall";
    scene.add(hallRoot);
    var keyLight = null;

    var renderer;
    try {
        renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            powerPreference: "high-performance"
        });
    } catch (error) {
        host.innerHTML = '<div class="hall-3d-error">3D preview is not available in this browser.</div>';
        return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.setAttribute("aria-label", "Interactive 3D hall layout");
    renderer.domElement.tabIndex = 0;
    host.appendChild(renderer.domElement);

    var perspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    var topCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 500);
    var activeCamera = perspectiveCamera;
    var cameraMode = "perspective";
    var controls = null;
    var isThreeView = false;

    var seatRoot = new THREE.Group();
    var labelRoot = new THREE.Group();
    scene.add(seatRoot);
    scene.add(labelRoot);

    var seatGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.14);
    var backGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.12);
    var baseGeometry = new THREE.CylinderGeometry(0.5, 0.58, 1, 16);
    var selectionGeometry = new THREE.RingGeometry(0.66, 0.82, 32);
    selectionGeometry.rotateX(-Math.PI / 2);

    var seatMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.58,
        metalness: 0.06
    });
    var backMaterial = seatMaterial.clone();
    var baseMaterial = new THREE.MeshStandardMaterial({
        color: 0x303845,
        roughness: 0.7,
        metalness: 0.18
    });
    var selectionMaterial = new THREE.MeshBasicMaterial({
        color: 0xffc857,
        transparent: true,
        opacity: 0.96,
        side: THREE.DoubleSide,
        depthWrite: false
    });

    var seatMesh = null;
    var backMesh = null;
    var baseMesh = null;
    var selectionMesh = null;
    var instanceKeys = [];
    var instanceByKey = new Map();
    var labelSprites = [];
    var labelTextures = new Map();
    var dummy = new THREE.Object3D();
    var yAxis = new THREE.Vector3(0, 1, 0);
    var raycaster = new THREE.Raycaster();
    var pointer = new THREE.Vector2();
    var floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    var hitPoint = new THREE.Vector3();
    var drag = null;

    buildLighting();
    buildHall();
    rebuildSeats(state);
    setCameraMode("perspective", true);
    resize();
    renderer.setAnimationLoop(renderFrame);

    var unsubscribe = editor.subscribe(function (nextState) {
        var dimensionsChanged = nextState.width !== state.width ||
            nextState.height !== state.height;
        var needsRebuild = nextState.seats.length !== instanceKeys.length ||
            nextState.seats.some(function (seat, index) { return instanceKeys[index] !== seat.key; });
        state = nextState;
        if (dimensionsChanged) {
            worldWidth = state.width / PIXELS_PER_METER;
            worldDepth = state.height / PIXELS_PER_METER;
            buildHall();
            if (controls) {
                controls.maxDistance = Math.max(80, Math.max(worldWidth, worldDepth) * 8);
            }
        }
        if (needsRebuild) {
            rebuildSeats(state);
        } else {
            updateSeatTransforms(state);
        }
        updateSelectionStatus();
        host.classList.toggle("editing", state.editing);
        if (dimensionsChanged && isThreeView) {
            requestAnimationFrame(fitView);
        }
    });

    viewPlan.addEventListener("click", function () { activateView(false); });
    view3d.addEventListener("click", function () { activateView(true); });
    cameraPerspective.addEventListener("click", function () { setCameraMode("perspective", false); });
    cameraTop.addEventListener("click", function () { setCameraMode("top", false); });
    fitButton.addEventListener("click", fitView);

    renderer.domElement.addEventListener("pointerdown", onPointerDown, true);
    renderer.domElement.addEventListener("pointermove", onPointerHover);
    renderer.domElement.addEventListener("pointerleave", function () {
        if (!drag) { host.classList.remove("seat-hover"); }
    });
    renderer.domElement.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
            editor.select([]);
            renderer.domElement.focus();
        }
    });

    var resizeObserver = new ResizeObserver(function () {
        if (isThreeView) { resize(); }
    });
    resizeObserver.observe(host);

    window.addEventListener("pagehide", dispose, { once: true });

    function buildLighting() {
        var hemisphere = new THREE.HemisphereLight(0xf8fbff, 0x252a34, 2.25);
        scene.add(hemisphere);

        keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
        keyLight.castShadow = true;
        keyLight.shadow.mapSize.set(2048, 2048);
        scene.add(keyLight);
    }

    function buildHall() {
        clearHall();
        var hall = hallRoot;
        var span = Math.max(worldWidth, worldDepth);
        var shadowSpan = Math.max(18, span * 0.82);
        var cameraFar = Math.max(500, span * 12);
        perspectiveCamera.far = cameraFar;
        topCamera.far = cameraFar;
        perspectiveCamera.updateProjectionMatrix();
        topCamera.updateProjectionMatrix();
        scene.fog.near = Math.max(45, span * 1.4);
        scene.fog.far = Math.max(180, span * 7);
        keyLight.position.set(
            -Math.max(6, worldWidth * 0.35),
            Math.max(14, span * 0.82),
            Math.max(8, worldDepth * 0.42)
        );
        keyLight.shadow.camera.left = -shadowSpan;
        keyLight.shadow.camera.right = shadowSpan;
        keyLight.shadow.camera.top = shadowSpan;
        keyLight.shadow.camera.bottom = -shadowSpan;
        keyLight.shadow.camera.far = Math.max(60, span * 4);
        keyLight.shadow.camera.updateProjectionMatrix();

        var floorMaterial = new THREE.MeshStandardMaterial({
            color: 0xd8dde5,
            roughness: 0.92,
            metalness: 0
        });
        var floor = new THREE.Mesh(
            new RoundedBoxGeometry(worldWidth + 2.5, 0.24, worldDepth + 2.5, 3, 0.22),
            floorMaterial
        );
        floor.position.y = -0.16;
        floor.receiveShadow = true;
        hall.add(floor);

        var gridSize = Math.max(worldWidth, worldDepth) + 1.5;
        var grid = new THREE.GridHelper(gridSize, Math.max(12, Math.round(gridSize * 2)), 0x9ba6b6, 0xb8c0cb);
        grid.position.y = -0.025;
        grid.material.transparent = true;
        grid.material.opacity = 0.28;
        hall.add(grid);

        var boundaryMaterial = new THREE.MeshStandardMaterial({
            color: 0x8893a3,
            roughness: 0.8
        });
        var sideGeometry = new RoundedBoxGeometry(0.16, 0.42, worldDepth + 2.3, 2, 0.06);
        [-1, 1].forEach(function (side) {
            var rail = new THREE.Mesh(sideGeometry, boundaryMaterial);
            rail.position.set(side * (worldWidth / 2 + 1.12), 0.15, 0);
            rail.receiveShadow = true;
            hall.add(rail);
        });

        var stageWidth = Math.min(state.width * 0.6, 520) / PIXELS_PER_METER;
        var stageDepth = 1.02;
        var stageZ = 60 / PIXELS_PER_METER - worldDepth / 2;
        var stage = new THREE.Mesh(
            new RoundedBoxGeometry(stageWidth, 0.38, stageDepth, 3, 0.16),
            new THREE.MeshStandardMaterial({
                color: 0x202630,
                roughness: 0.52,
                metalness: 0.18
            })
        );
        stage.position.set(0, 0.15, stageZ);
        stage.castShadow = true;
        stage.receiveShadow = true;
        hall.add(stage);

        var stageEdge = new THREE.Mesh(
            new RoundedBoxGeometry(stageWidth * 0.9, 0.08, 0.08, 2, 0.03),
            new THREE.MeshStandardMaterial({
                color: 0xe6ad4a,
                emissive: 0x5a3510,
                emissiveIntensity: 0.18,
                roughness: 0.42
            })
        );
        stageEdge.position.set(0, 0.37, stageZ + stageDepth / 2 - 0.08);
        hall.add(stageEdge);

        var stageLabel = createStageLabel();
        stageLabel.position.set(0, 0.37, stageZ);
        stageLabel.rotation.x = -Math.PI / 2;
        hall.add(stageLabel);

        var stageLight = new THREE.SpotLight(0xffd79a, 18, 26, Math.PI / 5, 0.55, 1.6);
        stageLight.position.set(0, 9, stageZ - 2);
        stageLight.target.position.set(0, 0, stageZ + 3);
        hall.add(stageLight);
        hall.add(stageLight.target);
    }

    function clearHall() {
        hallRoot.traverse(function (object) {
            if (object.geometry) { object.geometry.dispose(); }
            var materials = object.material
                ? (Array.isArray(object.material) ? object.material : [object.material])
                : [];
            materials.forEach(function (material) {
                Object.keys(material).forEach(function (key) {
                    var value = material[key];
                    if (value && value.isTexture) { value.dispose(); }
                });
                material.dispose();
            });
            if (object.shadow && typeof object.shadow.dispose === "function") {
                object.shadow.dispose();
            }
        });
        hallRoot.clear();
    }

    function createStageLabel() {
        var canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 128;
        var context = canvas.getContext("2d");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffffff";
        context.font = "800 44px system-ui, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText("STAGE", canvas.width / 2, canvas.height / 2);
        var texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        var material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        return new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.85), material);
    }

    function rebuildSeats(nextState) {
        [seatMesh, backMesh, baseMesh, selectionMesh].forEach(function (mesh) {
            if (mesh) { seatRoot.remove(mesh); }
        });
        clearLabels();

        var capacity = Math.max(1, nextState.seats.length);
        seatMesh = new THREE.InstancedMesh(seatGeometry, seatMaterial, capacity);
        backMesh = new THREE.InstancedMesh(backGeometry, backMaterial, capacity);
        baseMesh = new THREE.InstancedMesh(baseGeometry, baseMaterial, capacity);
        selectionMesh = new THREE.InstancedMesh(selectionGeometry, selectionMaterial, capacity);
        seatMesh.count = nextState.seats.length;
        backMesh.count = nextState.seats.length;
        baseMesh.count = nextState.seats.length;
        selectionMesh.count = 0;

        [seatMesh, backMesh, baseMesh].forEach(function (mesh) {
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            seatRoot.add(mesh);
        });
        selectionMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        selectionMesh.renderOrder = 4;
        seatRoot.add(selectionMesh);

        instanceKeys = nextState.seats.map(function (seat) { return seat.key; });
        instanceByKey = new Map();
        instanceKeys.forEach(function (key, index) { instanceByKey.set(key, index); });

        if (nextState.seats.length <= MAX_LABELS) {
            nextState.seats.forEach(function (seat) {
                var sprite = createSeatLabel(seat.label);
                sprite.userData.seatKey = seat.key;
                labelRoot.add(sprite);
                labelSprites.push(sprite);
            });
        }

        updateSeatTransforms(nextState);
    }

    function updateSeatTransforms(nextState) {
        var selected = new Set(nextState.selectedKeys);
        var selectionIndex = 0;

        nextState.seats.forEach(function (seat, index) {
            var position = seatPosition(seat);
            var yaw = -THREE.MathUtils.degToRad(seat.rot || 0);
            var seatWidth = Math.max(0.42, seat.w / PIXELS_PER_METER * 0.94);
            var seatDepth = Math.max(0.38, seat.h / PIXELS_PER_METER * 0.74);
            var typeColor = TYPE_COLORS[seat.type] || TYPE_COLORS.REGULAR;

            dummy.position.set(position.x, 0.43, position.z);
            dummy.rotation.set(0, yaw, 0);
            dummy.scale.set(seatWidth, 0.3, seatDepth);
            dummy.updateMatrix();
            seatMesh.setMatrixAt(index, dummy.matrix);
            seatMesh.setColorAt(index, typeColor);

            var backOffset = new THREE.Vector3(0, 0, seatDepth * 0.42).applyAxisAngle(yAxis, yaw);
            dummy.position.set(position.x + backOffset.x, 0.83, position.z + backOffset.z);
            dummy.rotation.set(THREE.MathUtils.degToRad(-7), yaw, 0);
            dummy.scale.set(seatWidth, 0.62, Math.max(0.12, seatDepth * 0.2));
            dummy.updateMatrix();
            backMesh.setMatrixAt(index, dummy.matrix);
            backMesh.setColorAt(index, typeColor);

            dummy.position.set(position.x, 0.18, position.z);
            dummy.rotation.set(0, yaw, 0);
            dummy.scale.set(Math.max(0.18, seatWidth * 0.3), 0.34, Math.max(0.18, seatDepth * 0.34));
            dummy.updateMatrix();
            baseMesh.setMatrixAt(index, dummy.matrix);

            if (selected.has(seat.key)) {
                dummy.position.set(position.x, 0.015, position.z);
                dummy.rotation.set(0, yaw, 0);
                dummy.scale.set(
                    Math.max(0.68, seatWidth / 0.82),
                    1,
                    Math.max(0.68, seatDepth / 0.82)
                );
                dummy.updateMatrix();
                selectionMesh.setMatrixAt(selectionIndex++, dummy.matrix);
            }

            var label = labelSprites[index];
            if (label) {
                label.position.set(position.x, 1.28, position.z);
                label.scale.set(Math.max(0.54, seatWidth * 0.9), 0.28, 1);
            }
        });

        selectionMesh.count = selectionIndex;
        [seatMesh, backMesh, baseMesh, selectionMesh].forEach(function (mesh) {
            mesh.instanceMatrix.needsUpdate = true;
        });
        if (seatMesh.instanceColor) { seatMesh.instanceColor.needsUpdate = true; }
        if (backMesh.instanceColor) { backMesh.instanceColor.needsUpdate = true; }
    }

    function seatPosition(seat) {
        return {
            x: (seat.x + seat.w / 2) / PIXELS_PER_METER - worldWidth / 2,
            z: (seat.y + seat.h / 2) / PIXELS_PER_METER - worldDepth / 2
        };
    }

    function createSeatLabel(label) {
        var texture = labelTextures.get(label);
        if (!texture) {
            var canvas = document.createElement("canvas");
            canvas.width = 160;
            canvas.height = 72;
            var context = canvas.getContext("2d");
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "rgba(21, 25, 32, .82)";
            context.beginPath();
            context.roundRect(18, 8, 124, 56, 18);
            context.fill();
            context.fillStyle = "#ffffff";
            context.font = "800 30px system-ui, sans-serif";
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(label, 80, 36);
            texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            labelTextures.set(label, texture);
        }
        var material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: true,
            depthWrite: false
        });
        var sprite = new THREE.Sprite(material);
        sprite.renderOrder = 3;
        return sprite;
    }

    function clearLabels() {
        labelSprites.forEach(function (sprite) {
            labelRoot.remove(sprite);
            sprite.material.dispose();
        });
        labelSprites = [];
    }

    function activateView(showThree) {
        isThreeView = showThree;
        planView.classList.toggle("hidden", showThree);
        threeView.classList.toggle("hidden", !showThree);
        threeToolbar.classList.toggle("hidden", !showThree);
        viewPlan.classList.toggle("active", !showThree);
        view3d.classList.toggle("active", showThree);
        viewPlan.setAttribute("aria-selected", String(!showThree));
        view3d.setAttribute("aria-selected", String(showThree));
        if (showThree) {
            requestAnimationFrame(function () {
                resize();
                fitView();
                renderer.domElement.focus({ preventScroll: true });
            });
        }
    }

    function setCameraMode(mode, initial) {
        cameraMode = mode;
        activeCamera = mode === "top" ? topCamera : perspectiveCamera;
        cameraPerspective.classList.toggle("active", mode === "perspective");
        cameraTop.classList.toggle("active", mode === "top");
        cameraPerspective.setAttribute("aria-pressed", String(mode === "perspective"));
        cameraTop.setAttribute("aria-pressed", String(mode === "top"));
        if (controls) { controls.dispose(); }
        controls = new OrbitControls(activeCamera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.screenSpacePanning = true;
        controls.maxPolarAngle = Math.PI / 2.04;
        controls.enableRotate = mode !== "top";
        controls.minDistance = 3;
        controls.maxDistance = Math.max(80, Math.max(worldWidth, worldDepth) * 8);
        if (!initial) { fitView(); }
    }

    function fitView() {
        var span = Math.max(worldWidth, worldDepth);
        if (cameraMode === "top") {
            var aspect = Math.max(0.2, host.clientWidth / Math.max(1, host.clientHeight));
            var halfHeight = Math.max(worldDepth * 0.66, worldWidth / aspect * 0.66, 5);
            topCamera.left = -halfHeight * aspect;
            topCamera.right = halfHeight * aspect;
            topCamera.top = halfHeight;
            topCamera.bottom = -halfHeight;
            topCamera.position.set(0, Math.max(18, span * 2.2), 0.01);
            topCamera.lookAt(0, 0, 0);
            topCamera.updateProjectionMatrix();
            controls.target.set(0, 0, 0);
        } else {
            controls.target.set(0, 0.35, Math.min(1.5, worldDepth * 0.12));
            var perspectiveAspect = Math.max(0.25, host.clientWidth / Math.max(1, host.clientHeight));
            var verticalFov = THREE.MathUtils.degToRad(perspectiveCamera.fov);
            var horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * perspectiveAspect);
            var viewDirection = perspectiveAspect < 0.9
                ? new THREE.Vector3(0.08, 0.88, 0.46).normalize()
                : new THREE.Vector3(0.5, 0.72, 0.52).normalize();
            var cameraDistance = fitPerspectiveDistance(
                viewDirection,
                controls.target,
                horizontalFov,
                verticalFov
            );
            perspectiveCamera.position.copy(controls.target).addScaledVector(viewDirection, cameraDistance);
            perspectiveCamera.lookAt(controls.target);
        }
        controls.update();
    }

    function fitPerspectiveDistance(viewDirection, target, horizontalFov, verticalFov) {
        var worldUp = new THREE.Vector3(0, 1, 0);
        var cameraRight = new THREE.Vector3().crossVectors(worldUp, viewDirection).normalize();
        var cameraUp = new THREE.Vector3().crossVectors(viewDirection, cameraRight).normalize();
        var halfWidth = (worldWidth + 2.5) / 2;
        var halfDepth = (worldDepth + 2.5) / 2;
        var tanHorizontal = Math.tan(horizontalFov / 2);
        var tanVertical = Math.tan(verticalFov / 2);
        var requiredDistance = 0;

        [-halfWidth, halfWidth].forEach(function (x) {
            [-0.25, 1.55].forEach(function (y) {
                [-halfDepth, halfDepth].forEach(function (z) {
                    var offset = new THREE.Vector3(x, y, z).sub(target);
                    var forward = offset.dot(viewDirection);
                    requiredDistance = Math.max(
                        requiredDistance,
                        forward + Math.abs(offset.dot(cameraRight)) / tanHorizontal,
                        forward + Math.abs(offset.dot(cameraUp)) / tanVertical
                    );
                });
            });
        });

        return requiredDistance * 1.08;
    }

    function resize() {
        var width = Math.max(1, host.clientWidth);
        var height = Math.max(1, host.clientHeight);
        renderer.setSize(width, height, false);
        perspectiveCamera.aspect = width / height;
        perspectiveCamera.updateProjectionMatrix();
        if (cameraMode === "top") { fitView(); }
    }

    function renderFrame() {
        if (!isThreeView) { return; }
        controls.update();
        renderer.render(scene, activeCamera);
    }

    function updatePointer(event) {
        var rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, activeCamera);
    }

    function pickSeat(event) {
        updatePointer(event);
        var hits = raycaster.intersectObjects([seatMesh, backMesh], false);
        if (!hits.length || hits[0].instanceId == null) { return null; }
        return instanceKeys[hits[0].instanceId] || null;
    }

    function onPointerHover(event) {
        if (drag || !isThreeView) { return; }
        host.classList.toggle("seat-hover", Boolean(pickSeat(event)));
    }

    function onPointerDown(event) {
        if (!isThreeView || event.button !== 0) { return; }
        var key = pickSeat(event);
        if (!key) {
            if (!event.shiftKey) { editor.select([]); }
            return;
        }

        var selectedKeys = state.selectedKeys.slice();
        if (event.shiftKey) {
            var selectedIndex = selectedKeys.indexOf(key);
            if (selectedIndex === -1) { selectedKeys.push(key); }
            else { selectedKeys.splice(selectedIndex, 1); }
            editor.select(selectedKeys);
            return;
        }

        if (selectedKeys.indexOf(key) === -1) {
            editor.select([key]);
            selectedKeys = [key];
        }
        if (!state.editing) { return; }

        event.preventDefault();
        event.stopImmediatePropagation();
        updatePointer(event);
        if (!raycaster.ray.intersectPlane(floorPlane, hitPoint)) { return; }

        var seatsByKey = new Map(state.seats.map(function (seat) { return [seat.key, seat]; }));
        var originals = selectedKeys.map(function (selectedKey) {
            var seat = seatsByKey.get(selectedKey);
            return seat ? { key: selectedKey, x: seat.x, y: seat.y, w: seat.w, h: seat.h } : null;
        }).filter(Boolean);

        drag = {
            pointerId: event.pointerId,
            startWorldX: hitPoint.x,
            startWorldZ: hitPoint.z,
            originals: originals,
            lastPatches: [],
            moved: false
        };
        controls.enabled = false;
        host.classList.add("dragging");
        renderer.domElement.setPointerCapture(event.pointerId);
        window.addEventListener("pointermove", onDragMove, true);
        window.addEventListener("pointerup", onDragEnd, true);
        window.addEventListener("pointercancel", onDragEnd, true);
    }

    function onDragMove(event) {
        if (!drag || event.pointerId !== drag.pointerId) { return; }
        event.preventDefault();
        updatePointer(event);
        if (!raycaster.ray.intersectPlane(floorPlane, hitPoint)) { return; }

        var dx = (hitPoint.x - drag.startWorldX) * PIXELS_PER_METER;
        var dy = (hitPoint.z - drag.startWorldZ) * PIXELS_PER_METER;
        if (Math.abs(dx) + Math.abs(dy) > 0.8) { drag.moved = true; }

        var appliedDx = dx;
        var appliedDy = dy;
        if (!event.altKey && drag.originals.length) {
            appliedDx = Math.round((drag.originals[0].x + dx) / SNAP_PIXELS) * SNAP_PIXELS -
                drag.originals[0].x;
            appliedDy = Math.round((drag.originals[0].y + dy) / SNAP_PIXELS) * SNAP_PIXELS -
                drag.originals[0].y;
        }

        var minDx = Math.max.apply(null, drag.originals.map(function (original) {
            return -original.x;
        }));
        var minDy = Math.max.apply(null, drag.originals.map(function (original) {
            return -original.y;
        }));
        appliedDx = Math.max(appliedDx, minDx);
        appliedDy = Math.max(appliedDy, minDy);

        drag.lastPatches = drag.originals.map(function (original) {
            return {
                key: original.key,
                x: original.x + appliedDx,
                y: original.y + appliedDy
            };
        });

        var patchByKey = new Map(drag.lastPatches.map(function (patch) { return [patch.key, patch]; }));
        var previewState = Object.assign({}, state, {
            seats: state.seats.map(function (seat) {
                var patch = patchByKey.get(seat.key);
                return patch ? Object.assign({}, seat, patch) : seat;
            })
        });
        updateSeatTransforms(previewState);
        editor.applySpatialPatch(drag.lastPatches, { transient: true });
    }

    function onDragEnd(event) {
        if (!drag || event.pointerId !== drag.pointerId) { return; }
        var completedDrag = drag;
        drag = null;
        window.removeEventListener("pointermove", onDragMove, true);
        window.removeEventListener("pointerup", onDragEnd, true);
        window.removeEventListener("pointercancel", onDragEnd, true);
        if (renderer.domElement.hasPointerCapture(completedDrag.pointerId)) {
            renderer.domElement.releasePointerCapture(completedDrag.pointerId);
        }
        controls.enabled = true;
        host.classList.remove("dragging");
        if (completedDrag.moved && completedDrag.lastPatches.length) {
            editor.applySpatialPatch(completedDrag.lastPatches);
        } else {
            updateSeatTransforms(state);
        }
    }

    function updateSelectionStatus() {
        var selectedSeats = state.seats.filter(function (seat) {
            return state.selectedKeys.indexOf(seat.key) !== -1;
        });
        if (selectedSeats.length === 1) {
            selectionStatus.textContent = selectedSeats[0].label + " - " + selectedSeats[0].type;
        } else if (selectedSeats.length > 1) {
            selectionStatus.textContent = selectedSeats.length + " seats selected";
        } else {
            selectionStatus.textContent = state.editing ? "Edit enabled" : "View only";
        }
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function dispose() {
        unsubscribe();
        resizeObserver.disconnect();
        renderer.setAnimationLoop(null);
        if (controls) { controls.dispose(); }
        clearHall();
        if (keyLight && keyLight.shadow && typeof keyLight.shadow.dispose === "function") {
            keyLight.shadow.dispose();
        }
        clearLabels();
        labelTextures.forEach(function (texture) { texture.dispose(); });
        [seatGeometry, backGeometry, baseGeometry, selectionGeometry].forEach(function (geometry) {
            geometry.dispose();
        });
        [seatMaterial, backMaterial, baseMaterial, selectionMaterial].forEach(function (material) {
            material.dispose();
        });
        renderer.dispose();
    }
})();
