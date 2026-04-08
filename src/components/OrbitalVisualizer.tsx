import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ============================================================================
// BASE DE DATOS EPHEMERIS: Escala Matemática Real (Época J2000 aprox)
// a = Semieje Mayor (Millones de km) | e = Excentricidad
// i = Inclinación orbital (grados) | period = Período orbital (Días)
// ============================================================================
const SOLAR_SYSTEM: Record<string, any> = {
    sun: { id: 'sun', name: 'El Sol', radius: 696340, mu: 132712440000, color: 0xfacc15, a: 0, e: 0, i: 0, period: 1, axialTilt: 7.25, rotPeriod: 609.1 },
    mercury: { id: 'mercury', name: 'Mercurio', radius: 2439, mu: 22032, color: 0x94a3b8, a: 57.9, e: 0.205, i: 7.0, period: 88.0, axialTilt: 0.03, rotPeriod: 1407.6 },
    venus: { id: 'venus', name: 'Venus', radius: 6051, mu: 324859, color: 0xfdba74, a: 108.2, e: 0.0067, i: 3.39, period: 224.7, axialTilt: 177.3, rotPeriod: -5832.5 },
    earth: { id: 'earth', name: 'La Tierra', radius: 6371, mu: 398600, color: 0x0ea5e9, a: 149.6, e: 0.0167, i: 0, period: 365.25, axialTilt: 23.44, rotPeriod: 23.93, 
        moons: [{ id: 'moon', name: 'La Luna', radius: 1737, mu: 4902, color: 0xcbd5e1, a: 0.384, e: 0.0549, i: 5.14, period: 27.32, axialTilt: 6.68, rotPeriod: 655.7 }] 
    },
    mars: { id: 'mars', name: 'Marte', radius: 3389, mu: 42828, color: 0xef4444, a: 227.9, e: 0.0934, i: 1.85, period: 687.0, axialTilt: 25.19, rotPeriod: 24.62 },
    jupiter: { id: 'jupiter', name: 'Júpiter', radius: 69911, mu: 126686534, color: 0xd97706, a: 778.6, e: 0.0489, i: 1.3, period: 4331, axialTilt: 3.13, rotPeriod: 9.92,
        moons: [
            { id: 'io', name: 'Ío', radius: 1821, mu: 5959, color: 0xfef08a, a: 0.421, e: 0.004, i: 0.05, period: 1.76, axialTilt: 0, rotPeriod: 42.4 },
            { id: 'europa', name: 'Europa', radius: 1560, mu: 3202, color: 0xe2e8f0, a: 0.671, e: 0.009, i: 0.47, period: 3.55, axialTilt: 0, rotPeriod: 85.2 }
        ]
    },
    saturn: { id: 'saturn', name: 'Saturno', radius: 58232, mu: 37931187, color: 0xfde047, a: 1433.5, e: 0.0565, i: 2.48, period: 10747, axialTilt: 26.73, rotPeriod: 10.65, hasRings: true,
        moons: [{ id: 'titan', name: 'Titán', radius: 2574, mu: 8978, color: 0xf59e0b, a: 1.221, e: 0.028, i: 0.34, period: 15.94, axialTilt: 0, rotPeriod: 382.6 }]
    },
    uranus: { id: 'uranus', name: 'Urano', radius: 25362, mu: 5793939, color: 0x38bdf8, a: 2872.5, e: 0.0457, i: 0.77, period: 30589, axialTilt: 97.77, rotPeriod: -17.24, hasRings: true },
    neptune: { id: 'neptune', name: 'Neptuno', radius: 24622, mu: 6836529, color: 0x3b82f6, a: 4495.1, e: 0.0113, i: 1.76, period: 59800, axialTilt: 28.32, rotPeriod: 16.11 }
};

const solveKepler = (M: number, e: number) => {
    let E = M;
    for(let i=0; i<5; i++) { E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); }
    return E;
};

const createLabel = (text: string, colorStr: string, bodyId: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.fillStyle = colorStr;
        ctx.font = 'bold 48px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(text, 256, 80);
    }
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.renderOrder = 999;
    sprite.userData = { id: bodyId, isLabel: true };
    return sprite;
};

const OrbitalVisualizer = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    
    const SCALE = 1000.0; // 1 unidad 3D = 1000 km
    
    const targetBody = useRef(SOLAR_SYSTEM.earth);
    const timeRef = useRef(0); 
    const timeWarpRef = useRef<number>(1.0);
    
    const satPos = useRef(new THREE.Vector3());
    const satVel = useRef(new THREE.Vector3());
    const thrustControls = useRef({ prograde: false, retrograde: false, normal: false, radial: false, power: 9.8 });
    
    const universeGroup = useRef(new THREE.Group());
    const localSatGroup = useRef(new THREE.Group());
    const bodyMeshes = useRef<Record<string, { mesh: THREE.Group, data: any, parentId?: string }>>({});
    
    const predictionGeo = useRef<THREE.BufferGeometry | null>(null);
    const trailGeo = useRef<THREE.BufferGeometry | null>(null);
    const trailPositions = useRef<Float32Array>(new Float32Array(5000 * 3));
    const trailIdx = useRef(0);

    const targetCamPos = useRef(new THREE.Vector3(0, 20, 40));
    const clickableObjects = useRef<THREE.Object3D[]>([]);

    useEffect(() => {
        if (!containerRef.current) return;
        let animationFrameId: number;

        // --- INICIALIZACIÓN NATIVA ESTABLE ---
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x020617); 
        scene.add(universeGroup.current);
        scene.add(localSatGroup.current);
        
        // Frustum masivo pero seguro (0.1 a 5 Millones)
        const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 5000000);
        camera.position.set(0, 20, 40);
        targetCamPos.current.copy(camera.position);

        // Renderizador puro sin Bloom
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        containerRef.current.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.maxDistance = 2000000;

        // --- LUZ TÁCTICA ---
        scene.add(new THREE.AmbientLight(0x444444)); 
        const cameraLight = new THREE.PointLight(0xffffff, 2, 0, 0); // Foco frontal infinito
        camera.add(cameraLight);
        scene.add(camera);

        // --- BÓVEDA ESTELAR BLINDADA ---
        const starGeo = new THREE.BufferGeometry();
        const starCount = 4000;
        const starPos = new Float32Array(starCount * 3);
        const starColors = new Float32Array(starCount * 3);
        const color = new THREE.Color();
        
        for(let i=0; i<starCount; i++) {
            // Estrellas en una esfera local amplia
            const r = 400000 + Math.random() * 100000; 
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos((Math.random() * 2) - 1);
            starPos[i*3] = r * Math.sin(phi) * Math.cos(theta);
            starPos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
            starPos[i*3+2] = r * Math.cos(phi);
            
            const temp = Math.random();
            if (temp > 0.8) color.setHex(0x93c5fd); 
            else if (temp > 0.5) color.setHex(0xffffff); 
            else if (temp > 0.2) color.setHex(0xfde047); 
            else color.setHex(0xfca5a5); 
            
            starColors[i*3] = color.r; starColors[i*3+1] = color.g; starColors[i*3+2] = color.b;
        }
        starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
        starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
        
        // El sizeAttenuation: false GARANTIZA que siempre midan 2 píxeles sin importar la distancia
        const starMat = new THREE.PointsMaterial({ size: 2.0, vertexColors: true, transparent: true, opacity: 0.9, sizeAttenuation: false });
        const starsMesh = new THREE.Points(starGeo, starMat);
        scene.add(starsMesh);

        // --- CONSTRUCTOR DE PLANETAS ---
        const buildBody = (data: any, parentId?: string) => {
            const group = new THREE.Group();
            const visRadius = Math.max(0.2, data.radius / SCALE); // Límite inferior de tamaño
            
            const label = createLabel(data.name, `#${data.color.toString(16).padStart(6, '0')}`, data.id);
            label.position.y = visRadius + (parentId ? 2 : 10);
            group.add(label);
            clickableObjects.current.push(label);

            const geo = new THREE.SphereGeometry(visRadius, 32, 32); 
            const mat = new THREE.MeshStandardMaterial({ color: data.color, roughness: 0.7, metalness: 0.2 });
            const sphere = new THREE.Mesh(geo, mat);
            
            const edges = new THREE.EdgesGeometry(geo);
            const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2 }));
            sphere.add(line);

            sphere.rotation.x = THREE.MathUtils.degToRad(data.axialTilt || 0); 
            sphere.userData = { id: data.id };
            group.add(sphere);
            clickableObjects.current.push(sphere);

            if (data.hasRings) {
                const ringGeo = new THREE.RingGeometry(visRadius * 1.5, visRadius * 2.3, 64);
                const ringMat = new THREE.MeshBasicMaterial({ color: data.color, side: THREE.DoubleSide, transparent: true, opacity: 0.4, wireframe: true });
                const ringMesh = new THREE.Mesh(ringGeo, ringMat);
                ringMesh.rotation.x = Math.PI / 2.2;
                group.add(ringMesh);
            }

            // Órbitas Visuales (Añadidas directamente al Sol para que sigan el centro)
            if (data.a > 0 && !parentId) {
                const aScaled = (data.a * 1000000) / SCALE;
                const bScaled = aScaled * Math.sqrt(1 - data.e * data.e);
                const curve = new THREE.EllipseCurve(0, 0, aScaled, bScaled, 0, 2 * Math.PI, false, 0);
                const orbGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(128));
                const orbMat = new THREE.LineBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.4 });
                const orbLine = new THREE.Line(orbGeo, orbMat);
                orbLine.rotation.x = Math.PI / 2;
                orbLine.position.x = -(aScaled * data.e);
                
                // Las órbitas de los planetas se anclan al Sol
                if(bodyMeshes.current['sun']) {
                    bodyMeshes.current['sun'].mesh.add(orbLine);
                }
            }

            bodyMeshes.current[data.id] = { mesh: group, data, parentId };
            universeGroup.current.add(group); 
        };

        // Crear Sol primero para anclar las órbitas
        buildBody(SOLAR_SYSTEM.sun);
        Object.values(SOLAR_SYSTEM).forEach(p => { if (p.id !== 'sun') buildBody(p); });
        Object.values(SOLAR_SYSTEM).forEach(p => { if (p.moons) p.moons.forEach((m: any) => buildBody(m, p.id)); });

        // --- SISTEMA DEL COHETE LOCAL ---
        const satGeo = new THREE.OctahedronGeometry(0.1, 0); 
        const satMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 }); 
        const satMesh = new THREE.Mesh(satGeo, satMat);
        localSatGroup.current.add(satMesh);

        const satIconMat = new THREE.SpriteMaterial({ color: 0x34d399, depthTest: false, transparent: true, opacity: 0.9 });
        const satIcon = new THREE.Sprite(satIconMat);
        satMesh.add(satIcon);

        trailGeo.current = new THREE.BufferGeometry();
        trailGeo.current.setAttribute('position', new THREE.BufferAttribute(trailPositions.current, 3));
        const trailMat = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.6 });
        localSatGroup.current.add(new THREE.Line(trailGeo.current, trailMat));

        const maxPredictionPoints = 1000; 
        predictionGeo.current = new THREE.BufferGeometry();
        const predPositions = new Float32Array(maxPredictionPoints * 3);
        predictionGeo.current.setAttribute('position', new THREE.BufferAttribute(predPositions, 3));
        const predMat = new THREE.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.9 });
        localSatGroup.current.add(new THREE.Line(predictionGeo.current, predMat));

        // --- LECTURA SEGURA DE LA INTERFAZ ---
        const getSafeNumber = (id: string, fallback: number) => {
            const el = document.getElementById(id) as HTMLInputElement;
            if (el && el.value) {
                const val = parseFloat(el.value);
                return isNaN(val) ? fallback : val;
            }
            return fallback;
        };

        const injectSatellite = () => {
            trailPositions.current.fill(0); trailIdx.current = 0;
            if(trailGeo.current) trailGeo.current.setDrawRange(0, 0);

            const tb = targetBody.current;
            const altKm = getSafeNumber('orbitAltSlider', tb.radius * 0.1);
            const velKmS = getSafeNumber('orbitVelSlider', Math.sqrt(tb.mu / (tb.radius + altKm)));
            
            const r = (tb.radius + altKm) / SCALE;
            satPos.current.set(0, 0, r);
            satVel.current.set(velKmS / SCALE, 0, 0);
            
            controls.minDistance = (tb.radius / SCALE) + 0.2;
        };

        const updatePrediction = () => {
            const p = satPos.current.clone(); 
            const v = satVel.current.clone();
            const a = new THREE.Vector3();
            
            const predDt = 2.0; 
            let currentPt = 0;
            const posArray = predictionGeo.current!.attributes.position.array as Float32Array;
            
            const localMu = targetBody.current.mu / Math.pow(SCALE, 3);
            const crashRadiusSq = Math.pow(targetBody.current.radius / SCALE, 2);

            for (let i = 0; i < maxPredictionPoints; i++) {
                posArray[currentPt++] = p.x; posArray[currentPt++] = p.y; posArray[currentPt++] = p.z;
                
                const r2 = Math.max(p.lengthSq(), 0.0001); 
                if (r2 <= crashRadiusSq * 1.02) break; 

                const r = Math.sqrt(r2);
                a.copy(p).multiplyScalar(-localMu / (r2 * r));
                v.addScaledVector(a, predDt); 
                p.addScaledVector(v, predDt);

                if (i > 100 && p.distanceToSquared(satPos.current) < (v.lengthSq() * predDt * predDt * 2.0)) break; 
            }
            predictionGeo.current!.setDrawRange(0, Math.floor(currentPt / 3));
            predictionGeo.current!.attributes.position.needsUpdate = true;
        };

        // --- SISTEMA DE CLICKEADO Y EVENTOS ---
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        const triggerTargetChange = (clickedId: string) => {
            const selectEl = document.getElementById('planetSelect') as HTMLSelectElement;
            if (selectEl) { selectEl.value = clickedId; selectEl.dispatchEvent(new Event('change')); }
        };

        const onPointerDown = (event: MouseEvent) => {
            mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            
            const intersects = raycaster.intersectObjects(clickableObjects.current, false);
            if (intersects.length > 0) {
                const clickedId = intersects[0].object.userData.id;
                if (clickedId && bodyMeshes.current[clickedId]) triggerTargetChange(clickedId);
            }
        };
        window.addEventListener('pointerdown', onPointerDown);

        const bindControl = (id: string, event: string, handler: (e: any) => void) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, handler);
            return () => { if (el) el.removeEventListener(event, handler); };
        };

        const setThrust = (key: 'prograde'|'retrograde'|'normal'|'radial', val: boolean) => { thrustControls.current[key] = val; };

        const cleanups = [
            bindControl('planetSelect', 'change', (e) => {
                const newId = e.target.value;
                const newBody = Object.values(SOLAR_SYSTEM).find(b => b.id === newId) || 
                                Object.values(SOLAR_SYSTEM).flatMap(b => b.moons || []).find(m => m.id === newId);
                
                if (newBody) {
                    targetBody.current = newBody;
                    
                    const safeSet = (id: string, val: string) => { const el = document.getElementById(id); if(el) el.innerText = val; };
                    safeSet('hud-soi', newBody.name);
                    safeSet('hud-planet-name', newBody.name);
                    safeSet('hud-planet-mu', newBody.mu.toLocaleString());
                    safeSet('hud-planet-tilt', `${newBody.axialTilt || 0}°`);
                    safeSet('hud-planet-day', `${newBody.rotPeriod || 0} h`);

                    const altSlider = document.getElementById('orbitAltSlider') as HTMLInputElement;
                    const velSlider = document.getElementById('orbitVelSlider') as HTMLInputElement;
                    if (altSlider && velSlider) {
                        const r = newBody.radius;
                        altSlider.max = (r * 20).toString();
                        altSlider.step = Math.max(1, Math.floor(r / 100)).toString();
                        
                        const escVel = Math.sqrt(2 * newBody.mu / r);
                        velSlider.max = (escVel * 1.5).toFixed(1);
                        
                        const suggAlt = r * 0.1;
                        const suggVel = Math.sqrt(newBody.mu / (r + suggAlt));
                        
                        altSlider.value = suggAlt.toFixed(0);
                        velSlider.value = suggVel.toFixed(2);
                        safeSet('orbitAltDisplay', altSlider.value);
                        safeSet('orbitVelDisplay', velSlider.value);
                    }
                    
                    const rVis = Math.max(1.0, newBody.radius / SCALE);
                    targetCamPos.current.set(rVis * 3, rVis * 2, rVis * 4);
                    
                    injectSatellite();
                }
            }),
            bindControl('injectBtn', 'click', injectSatellite),
            bindControl('orbitAltSlider', 'input', (e) => { const el = document.getElementById('orbitAltDisplay'); if(el) el.innerText = e.target.value; }),
            bindControl('orbitVelSlider', 'input', (e) => { const el = document.getElementById('orbitVelDisplay'); if(el) el.innerText = parseFloat(e.target.value).toFixed(2); }),
            bindControl('timeWarpSlider', 'input', (e) => {
                const val = parseFloat(e.target.value);
                if(!isNaN(val)) {
                    timeWarpRef.current = val;
                    const el = document.getElementById('timeWarpDisplay');
                    if(el) el.innerText = `${timeWarpRef.current}x`;
                }
            }),
            bindControl('thrustPowerSlider', 'input', (e) => {
                const val = parseFloat(e.target.value);
                if(!isNaN(val)) {
                    thrustControls.current.power = val;
                    const el = document.getElementById('thrustPowerDisplay');
                    if(el) el.innerText = e.target.value;
                }
            }),
            
            bindControl('btnPrograde', 'mousedown', () => setThrust('prograde', true)), bindControl('btnPrograde', 'mouseup', () => setThrust('prograde', false)), bindControl('btnPrograde', 'mouseleave', () => setThrust('prograde', false)),
            bindControl('btnRetrograde', 'mousedown', () => setThrust('retrograde', true)), bindControl('btnRetrograde', 'mouseup', () => setThrust('retrograde', false)), bindControl('btnRetrograde', 'mouseleave', () => setThrust('retrograde', false)),
            bindControl('btnNormal', 'mousedown', () => setThrust('normal', true)), bindControl('btnNormal', 'mouseup', () => setThrust('normal', false)), bindControl('btnNormal', 'mouseleave', () => setThrust('normal', false)),
            bindControl('btnRadial', 'mousedown', () => setThrust('radial', true)), bindControl('btnRadial', 'mouseup', () => setThrust('radial', false)), bindControl('btnRadial', 'mouseleave', () => setThrust('radial', false))
        ];

        // --- BUCLE FÍSICO DE ORIGEN FLOTANTE ---
        let lastTime = performance.now();
        let frameCount = 0;

        const getAbsolutePositionJ2000 = (bodyData: any, timeDays: number) => {
            if (bodyData.a === 0) return new THREE.Vector3(0,0,0);
            const M = (timeDays / bodyData.period) * Math.PI * 2; 
            const E = solveKepler(M, bodyData.e);
            
            const aScaled = (bodyData.a * 1000000) / SCALE; 
            const x = aScaled * (Math.cos(E) - bodyData.e);
            const z = aScaled * Math.sqrt(1 - bodyData.e * bodyData.e) * Math.sin(E);
            
            const incRad = THREE.MathUtils.degToRad(bodyData.i || 0);
            return new THREE.Vector3(x, z * Math.sin(incRad), z * Math.cos(incRad));
        };

        // Forzar inicialización de UI tras cargar
        setTimeout(() => triggerTargetChange('earth'), 150);

        // Variables prealojadas para no ahogar la memoria (Cero basura generada por frame)
        const _gravAcc = new THREE.Vector3();
        const _thrustAcc = new THREE.Vector3();
        const _normal = new THREE.Vector3();
        const _radial = new THREE.Vector3();

        const animate = () => {
            animationFrameId = requestAnimationFrame(animate);
            
            starsMesh.position.copy(camera.position);

            camera.position.lerp(targetCamPos.current, 0.08);
            controls.target.set(0,0,0); 
            controls.update();

            const warp = timeWarpRef.current;
            const baseDt = 0.016; 
            timeRef.current += (baseDt * warp) / 86400.0; 

            // 1. EFEMÉRIDES J2000
            const absPositions: Record<string, THREE.Vector3> = {};
            Object.values(bodyMeshes.current).forEach(b => {
                if (!b.parentId) absPositions[b.data.id] = getAbsolutePositionJ2000(b.data, timeRef.current);
            });
            Object.values(bodyMeshes.current).forEach(b => {
                if (b.parentId) {
                    const localPos = getAbsolutePositionJ2000(b.data, timeRef.current);
                    localPos.add(absPositions[b.parentId] || new THREE.Vector3());
                    absPositions[b.data.id] = localPos;
                }
            });

            // 2. APLICAR ORIGEN FLOTANTE (Anclar el mundo al objetivo)
            const originOffset = absPositions[targetBody.current.id] ? absPositions[targetBody.current.id].clone() : new THREE.Vector3();
            
            Object.values(bodyMeshes.current).forEach(b => {
                if(!absPositions[b.data.id]) return;
                const relativePos = absPositions[b.data.id].clone().sub(originOffset);
                b.mesh.position.copy(relativePos);
                
                if(b.data.id !== 'sun') {
                    const sphere = b.mesh.children.find(c => c instanceof THREE.Mesh);
                    if(sphere) sphere.rotation.y += baseDt * warp * 0.0005;
                }
                
                const distToCam = camera.position.distanceTo(relativePos);
                b.mesh.children.forEach(child => {
                    if (child.userData.isLabel) {
                        const sf = Math.max(0.1, distToCam * 0.05); 
                        child.scale.set(100 * sf, 25 * sf, 1);
                        child.position.y = (b.data.radius / SCALE) + (5 * sf);
                    }
                });
            });

            // 3. DINÁMICA DEL COHETE
            const simDt = baseDt * warp;
            const subSteps = Math.max(1, Math.min(100, Math.ceil(warp / 5))); 
            const stepDt = simDt / subSteps;

            const r2 = satPos.current.lengthSq();
            const visRadiusSq = Math.pow(targetBody.current.radius / SCALE, 2);
            let isDestroyed = r2 <= visRadiusSq;
            let isThrusting = false;

            if (isDestroyed) {
                satVel.current.set(0,0,0);
                satMat.color.setHex(0xef4444); 
            } else {
                satMat.color.setHex(0xffffff);
                _thrustAcc.set(0,0,0);
                predMat.color.setHex(0x34d399); 

                const thrustPowerUnits = (thrustControls.current.power / 1000.0) / SCALE; 
                
                if (thrustControls.current.prograde) {
                    _thrustAcc.copy(satVel.current).normalize().multiplyScalar(thrustPowerUnits);
                    satMat.color.setHex(0x38bdf8); predMat.color.setHex(0x38bdf8); isThrusting = true;
                } else if (thrustControls.current.retrograde) {
                    _thrustAcc.copy(satVel.current).normalize().multiplyScalar(-thrustPowerUnits);
                    satMat.color.setHex(0xf97316); predMat.color.setHex(0xf97316); isThrusting = true;
                } else if (thrustControls.current.normal) {
                    _normal.crossVectors(satPos.current, satVel.current).normalize();
                    _thrustAcc.copy(_normal).multiplyScalar(thrustPowerUnits);
                    satMat.color.setHex(0x10b981); predMat.color.setHex(0x10b981); isThrusting = true;
                } else if (thrustControls.current.radial) {
                    _normal.crossVectors(satPos.current, satVel.current);
                    _radial.crossVectors(_normal, satVel.current).normalize();
                    _thrustAcc.copy(_radial).multiplyScalar(thrustPowerUnits);
                    satMat.color.setHex(0xc084fc); predMat.color.setHex(0xc084fc); isThrusting = true;
                }

                const localMu = targetBody.current.mu / Math.pow(SCALE, 3);

                // Integración segura in-place
                for(let i=0; i<subSteps; i++) {
                    const currentR2 = Math.max(satPos.current.lengthSq(), 1e-8); 
                    const r = Math.sqrt(currentR2);
                    _gravAcc.copy(satPos.current).multiplyScalar(-localMu / (currentR2 * r));
                    _gravAcc.add(_thrustAcc);
                    satVel.current.addScaledVector(_gravAcc, stepDt);
                    satPos.current.addScaledVector(satVel.current, stepDt);

                    // Escudo contra NaN por inestabilidad de Euler
                    if (isNaN(satPos.current.x)) {
                        satPos.current.set(0, (targetBody.current.radius/SCALE) + 1, 0);
                        satVel.current.set(0,0,0);
                        break;
                    }
                }

                if (frameCount % 4 === 0) {
                    const arr = trailPositions.current;
                    const idx = trailIdx.current * 3;
                    arr[idx] = satPos.current.x; arr[idx+1] = satPos.current.y; arr[idx+2] = satPos.current.z;
                    trailIdx.current = (trailIdx.current + 1) % 2000;
                    if(trailGeo.current) {
                        trailGeo.current.attributes.position.needsUpdate = true;
                        trailGeo.current.setDrawRange(0, trailIdx.current);
                    }
                }

                frameCount++;
                if (isThrusting || frameCount % 20 === 0) updatePrediction();
            }

            satMesh.position.copy(satPos.current);
            // El icono holográfico crece si alejas la cámara para que nunca lo pierdas
            satIcon.scale.set(camera.position.length() * 0.03, camera.position.length() * 0.03, 1); 
            
            renderer.render(scene, camera);

            // 4. TELEMETRÍA 
            const now = performance.now();
            if (now - lastTime >= 250) { 
                const v = satVel.current.length() * SCALE; 
                const alt = (satPos.current.length() * SCALE) - targetBody.current.radius; 
                
                const safeSet = (id: string, val: string) => { const el = document.getElementById(id); if(el) el.innerText = val; };
                
                safeSet('hud-vel', `${v.toFixed(3)} km/s`);
                safeSet('hud-alt', `${alt.toFixed(1)} km`);
                
                const statusEl = document.getElementById('hud-status');
                if (statusEl) {
                    if (isDestroyed) { statusEl.innerText = 'IMPACTO SUPERFICIE'; statusEl.style.color = '#ef4444'; } 
                    else if (alt > targetBody.current.radius * 200) { statusEl.innerText = 'ESCAPE HIPERBÓLICO / TRAYECTORIA'; statusEl.style.color = '#facc15'; } 
                    else { statusEl.innerText = isThrusting ? 'QUEMADO RCS ACTIVO' : 'ÓRBITA ESTABLE'; statusEl.style.color = isThrusting ? '#38bdf8' : '#34d399'; }
                }

                const trueMu = targetBody.current.mu;
                const truePosMag = Math.max(Math.sqrt(r2) * SCALE, 1);
                const specEnergy = (Math.pow(v, 2) / 2) - (trueMu / truePosMag);
                const a = -trueMu / (2 * specEnergy);
                
                const localMuVisual = targetBody.current.mu / Math.pow(SCALE, 3);
                _normal.crossVectors(satPos.current, satVel.current); 
                const eccVec = satVel.current.clone().cross(_normal).divideScalar(localMuVisual).sub(satPos.current.clone().normalize());
                const ecc = eccVec.length() || 0;

                let apo = 0, peri = 0;
                if (ecc < 1.0) {
                    apo = (a * (1 + ecc)) - targetBody.current.radius;
                    peri = (a * (1 - ecc)) - targetBody.current.radius;
                } else {
                    apo = Infinity; 
                    peri = (Math.abs(a) * (ecc - 1)) - targetBody.current.radius;
                }

                let apoText = "--";
                if (ecc >= 1.0) apoText = 'Infinito (Escape)';
                else if (!isNaN(apo) && apo !== Infinity && apo !== -Infinity) apoText = `${apo.toLocaleString(undefined, {maximumFractionDigits:1})} km`;
                
                safeSet('hud-apo', apoText);
                safeSet('hud-peri', !isNaN(peri) ? `${peri.toLocaleString(undefined, {maximumFractionDigits:1})} km` : '--');
                safeSet('hud-ecc', !isNaN(ecc) ? ecc.toFixed(5) : '--');
                safeSet('hud-sma', a > 0 && !isNaN(a) ? `${a.toLocaleString(undefined, {maximumFractionDigits:1})} km` : 'Hiperbólica');

                lastTime = now;
            }
        };

        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', handleResize);
            cleanups.forEach(c => c());
            renderer.dispose();
            if (containerRef.current && renderer.domElement) {
                containerRef.current.removeChild(renderer.domElement);
            }
        };
    }, []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, cursor: 'crosshair' }} />;
};

export default OrbitalVisualizer; 