import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
// @ts-ignore
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// @ts-ignore
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
// @ts-ignore
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
// @ts-ignore
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// --- SHADERS ---
const computationShaderPosition = `
    uniform float dt;
    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        gl_FragColor = vec4( pos.xyz + vel.xyz * dt, 1.0 );
    }
`;

const computationShaderVelocity = `
    uniform float gravity;
    uniform float softening;
    uniform float dt;
    uniform float mass1;
    uniform float mass2;
    uniform vec3 center1;
    uniform vec3 center2;

    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );

        vec3 acc = vec3(0.0);
        
        vec3 diff1 = center1 - pos.xyz;
        float distSq1 = dot(diff1, diff1) + softening;
        acc += gravity * mass1 * diff1 * pow(distSq1, -1.5);

        vec3 diff2 = center2 - pos.xyz;
        float distSq2 = dot(diff2, diff2) + softening;
        acc += gravity * mass2 * diff2 * pow(distSq2, -1.5);

        gl_FragColor = vec4( vel.xyz + acc * dt, 1.0 );
    }
`;

const vertexShader = `
    uniform sampler2D texturePosition;
    uniform sampler2D textureVelocity;
    uniform vec3 cameraPos;
    
    varying float vDensity;
    varying float vDoppler;

    void main() {
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        float distToCenter = length(pos.xyz);
        
        vDensity = 1.0 / (1.0 + distToCenter * 0.08);
        vDensity = clamp(vDensity, 0.0, 1.0);
        
        vec3 dirToCamera = normalize(cameraPos - pos.xyz);
        float approachSpeed = dot(vel.xyz, dirToCamera);
        vDoppler = approachSpeed;

        vec4 mvPosition = modelViewMatrix * vec4( pos.xyz, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        
        gl_PointSize = ( 18.0 / -mvPosition.z ) * (6.0 / pow(distToCenter + 1.0, 0.2));
    }
`;

const fragmentShader = `
    uniform float useDoppler;
    varying float vDensity;
    varying float vDoppler;

    void main() {
        float r = 0.0, g = 0.0, b = 0.0;
        
        if (vDensity > 0.6) { r = 1.0; g = 1.0; b = 0.9; } 
        else if (vDensity > 0.3) { r = 0.9; g = 0.8; b = 0.6; } 
        else { r = 0.3; g = 0.6; b = 1.0; }

        if (useDoppler > 0.5) {
            float shift = clamp(vDoppler * 0.08, -0.6, 0.6);
            if (shift > 0.0) {
                b += shift; r -= shift * 0.5;
            } else {
                r += abs(shift); b -= abs(shift) * 0.5;
            }
        }

        vec2 circCoord = 2.0 * gl_PointCoord - 1.0;
        float distSq = dot(circCoord, circCoord);
        if (distSq > 1.0) discard;
        
        float alpha = pow(1.0 - distSq, 3.0);
        gl_FragColor = vec4( r, g, b, alpha * (0.4 + vDensity * 0.4) );
    }
`;

const GalaxyVisualizer = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const isPausedRef = useRef<boolean>(false);

    useEffect(() => {
        if (!containerRef.current) return;

        const WIDTH = 256; 
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x010102); 
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
        camera.position.set(0, 120, 220);

        const renderer = new THREE.WebGLRenderer({ antialias: false });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.toneMapping = THREE.ReinhardToneMapping; 
        containerRef.current.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        const renderScene = new RenderPass(scene, camera);
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.6, 0.8, 0.1);
        const composer = new EffectComposer(renderer);
        composer.addPass(renderScene);
        composer.addPass(bloomPass);

        // --- OBJETOS VISUALES PARA EL MODO "AGUJEROS NEGROS" ---
        let bh1 = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), mass: 1500 };
        let bh2 = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), mass: 1500 };
        
        const bhGeometry = new THREE.SphereGeometry(2.5, 32, 32);
        const bhMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 }); // Esfera negra sólida
        const bhMesh1 = new THREE.Mesh(bhGeometry, bhMaterial);
        const bhMesh2 = new THREE.Mesh(bhGeometry, bhMaterial);
        
        const auraMat = new THREE.MeshBasicMaterial({ color: 0xffddaa, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending });
        const bhAura1 = new THREE.Mesh(new THREE.SphereGeometry(3.5, 16, 16), auraMat);
        const bhAura2 = new THREE.Mesh(new THREE.SphereGeometry(3.5, 16, 16), auraMat);
        bhMesh1.add(bhAura1); bhMesh2.add(bhAura2);
        
        scene.add(bhMesh1); scene.add(bhMesh2);

        const MAX_TRAIL = 200;
        const trailGeom1 = new THREE.BufferGeometry();
        const trailGeom2 = new THREE.BufferGeometry();
        trailGeom1.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3));
        trailGeom2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3));
        const trailLine1 = new THREE.Line(trailGeom1, new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.4 }));
        const trailLine2 = new THREE.Line(trailGeom2, new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.4 }));
        scene.add(trailLine1); scene.add(trailLine2);
        let trailIdx = 0;

        // --- GPU COMPUTE ---
        const gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);
        const dtPosition = gpuCompute.createTexture();
        const dtVelocity = gpuCompute.createTexture();
        const posArray = dtPosition.image.data as Float32Array;
        const velArray = dtVelocity.image.data as Float32Array;

        // LA FUNCIÓN DE GENERACIÓN AHORA DEPENDE DEL MODO ELEGIDO
        const generateInitialState = (type1: string, type2: string, mode: string) => {
            
            if (mode === 'galaxy') {
                // MODO 1: CHOQUE GALÁCTICO PURO
                // Ocultar esferas y líneas
                bhMesh1.visible = false; bhMesh2.visible = false;
                trailLine1.visible = false; trailLine2.visible = false;

                // Trayectoria de Colisión Frontal/Rasante
                bh1.pos.set(-80, 0, -20); bh1.vel.set(2.0, 0, 0.5); bh1.mass = 1200;
                bh2.pos.set(80, 0, 20);   bh2.vel.set(-2.0, 0, -0.5); bh2.mass = type2 === 'dwarf' ? 300 : 1200;

            } else {
                // MODO 2: AGUJEROS NEGROS BINARIOS
                // Mostrar esferas y líneas
                bhMesh1.visible = true; bhMesh2.visible = true;
                trailLine1.visible = true; trailLine2.visible = true;

                // Trayectoria Orbital Estable
                bh1.pos.set(-50, 0, 0); bh1.vel.set(0, 0, -3.2); bh1.mass = 1500;
                bh2.pos.set(50, 0, 0);  bh2.vel.set(0, 0, 3.2);  bh2.mass = 1500;
            }
            
            trailGeom1.attributes.position.array.fill(0);
            trailGeom2.attributes.position.array.fill(0);
            trailGeom1.attributes.position.needsUpdate = true;
            trailGeom2.attributes.position.needsUpdate = true;
            trailIdx = 0;

            const fillGalaxy = (offset: number, centerObj: any, type: string) => {
                const count = posArray.length / 2;
                for (let i = offset; i < offset + count; i += 4) {
                    let r = Math.random() * (type === 'dwarf' ? 20 : 50) + 2;
                    let theta = Math.random() * Math.PI * 2;
                    let x, y, z, vx, vy, vz;

                    if (type === 'elliptical') {
                        let phi = Math.acos((Math.random() * 2) - 1);
                        x = r * Math.sin(phi) * Math.cos(theta);
                        y = r * Math.sin(phi) * Math.sin(theta);
                        z = r * Math.cos(phi);
                        const vMag = Math.sqrt((0.5 * centerObj.mass) / r);
                        vx = (Math.random() - 0.5) * vMag;
                        vy = (Math.random() - 0.5) * vMag;
                        vz = (Math.random() - 0.5) * vMag;
                    } else {
                        x = Math.cos(theta) * r;
                        y = (Math.random() - 0.5) * 4; 
                        z = Math.sin(theta) * r;
                        const vMag = Math.sqrt((0.5 * centerObj.mass) / r);
                        vx = Math.sin(theta) * vMag;
                        vy = (Math.random() - 0.5) * 1.5;
                        vz = -Math.cos(theta) * vMag;
                    }

                    posArray[i] = x + centerObj.pos.x;
                    posArray[i+1] = y + centerObj.pos.y;
                    posArray[i+2] = z + centerObj.pos.z;
                    posArray[i+3] = 1;

                    velArray[i] = vx + centerObj.vel.x;
                    velArray[i+1] = vy + centerObj.vel.y;
                    velArray[i+2] = vz + centerObj.vel.z;
                    velArray[i+3] = 1;
                }
            };

            fillGalaxy(0, bh1, type1);
            fillGalaxy(posArray.length / 2, bh2, type2);
        };

        // Arrancamos en Modo Galaxia por defecto
        generateInitialState('spiral', 'spiral', 'galaxy');

        const posVar = gpuCompute.addVariable("texturePosition", computationShaderPosition, dtPosition);
        const velVar = gpuCompute.addVariable("textureVelocity", computationShaderVelocity, dtVelocity);
        gpuCompute.setVariableDependencies(posVar, [posVar, velVar]);
        gpuCompute.setVariableDependencies(velVar, [posVar, velVar]);
        
        posVar.material.uniforms.dt = { value: 0.016 };
        velVar.material.uniforms.dt = { value: 0.016 };
        velVar.material.uniforms.gravity = { value: 0.15 };
        velVar.material.uniforms.softening = { value: 3.5 };
        velVar.material.uniforms.mass1 = { value: bh1.mass };
        velVar.material.uniforms.mass2 = { value: bh2.mass };
        velVar.material.uniforms.center1 = { value: bh1.pos };
        velVar.material.uniforms.center2 = { value: bh2.pos };
        
        gpuCompute.init();

        // --- MATERIAL ESTELAR ---
        const geometry = new THREE.BufferGeometry();
        const uvs = new Float32Array(WIDTH * WIDTH * 2);
        for (let i = 0; i < WIDTH * WIDTH; i++) {
            uvs[i * 2] = (i % WIDTH) / WIDTH;
            uvs[i * 2 + 1] = Math.floor(i / WIDTH) / WIDTH;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WIDTH * WIDTH * 3), 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

        const material = new THREE.ShaderMaterial({
            uniforms: { 
                texturePosition: { value: null },
                textureVelocity: { value: null },
                cameraPos: { value: camera.position },
                useDoppler: { value: 1.0 }
            },
            vertexShader,
            fragmentShader,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        const points = new THREE.Points(geometry, material);
        scene.add(points);

        // --- CONEXIÓN DE UI ---
        const bindControl = (id: string, event: string, handler: (e: any) => void) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, handler);
            return () => { if (el) el.removeEventListener(event, handler); };
        };

        let currentG = 0.15;
        let currentDt = 0.016;

        const cleanups = [
            bindControl('pauseButton', 'click', (e) => {
                isPausedRef.current = !isPausedRef.current;
                e.target.innerText = isPausedRef.current ? "▶ Reanudar Simulación" : "Pausar Simulación";
                e.target.style.background = isPausedRef.current ? "rgba(34, 197, 94, 0.2)" : "rgba(250, 204, 21, 0.2)";
                e.target.style.color = isPausedRef.current ? "#86efac" : "#fef08a";
            }),
            bindControl('gravitySlider', 'input', (e) => {
                currentG = parseFloat(e.target.value);
                document.getElementById('gravityValueDisplay')!.innerText = currentG.toFixed(2);
                velVar.material.uniforms.gravity.value = currentG;
            }),
            bindControl('timeSlider', 'input', (e) => {
                currentDt = parseFloat(e.target.value);
                document.getElementById('timeValueDisplay')!.innerText = currentDt.toFixed(3);
                posVar.material.uniforms.dt.value = currentDt;
                velVar.material.uniforms.dt.value = currentDt;
            }),
            bindControl('dopplerToggle', 'change', (e) => {
                material.uniforms.useDoppler.value = e.target.checked ? 1.0 : 0.0;
            }),
            // Función maestra de reinicio / cambio de modo
            bindControl('simMode', 'change', () => document.getElementById('resetButton')?.click()),
            bindControl('resetButton', 'click', () => {
                const mode = (document.getElementById('simMode') as HTMLSelectElement).value;
                const t1 = (document.getElementById('typeGal1') as HTMLSelectElement).value;
                const t2 = (document.getElementById('typeGal2') as HTMLSelectElement).value;
                
                generateInitialState(t1, t2, mode);
                
                velVar.material.uniforms.mass1.value = bh1.mass;
                velVar.material.uniforms.mass2.value = bh2.mass;
                gpuCompute.renderTexture(dtPosition, posVar.renderTargets[0]);
                gpuCompute.renderTexture(dtPosition, posVar.renderTargets[1]);
                gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[0]);
                gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[1]);
            })
        ];

        // --- BUCLE DE ANIMACIÓN ---
        const animate = () => {
            requestAnimationFrame(animate);
            controls.update();
            material.uniforms.cameraPos.value.copy(camera.position);

            if (!isPausedRef.current) {
                // FÍSICA DE NÚCLEOS
                const dist = bh1.pos.clone().sub(bh2.pos);
                const r2 = dist.lengthSq() + 5.0; 
                const force = (currentG * bh1.mass * bh2.mass) / r2;
                
                const acc1 = dist.clone().normalize().multiplyScalar(-force / bh1.mass);
                const acc2 = dist.clone().normalize().multiplyScalar(force / bh2.mass);
                
                bh1.vel.add(acc1.multiplyScalar(currentDt));
                bh2.vel.add(acc2.multiplyScalar(currentDt));
                bh1.pos.add(bh1.vel.clone().multiplyScalar(currentDt));
                bh2.pos.add(bh2.vel.clone().multiplyScalar(currentDt));

                velVar.material.uniforms.center1.value.copy(bh1.pos);
                velVar.material.uniforms.center2.value.copy(bh2.pos);

                // Solo actualizar visuales si estamos en modo agujeros negros
                if (bhMesh1.visible) {
                    bhMesh1.position.copy(bh1.pos);
                    bhMesh2.position.copy(bh2.pos);

                    if (trailIdx < MAX_TRAIL) {
                        const arr1 = trailGeom1.attributes.position.array as Float32Array;
                        const arr2 = trailGeom2.attributes.position.array as Float32Array;
                        arr1[trailIdx*3] = bh1.pos.x; arr1[trailIdx*3+1] = bh1.pos.y; arr1[trailIdx*3+2] = bh1.pos.z;
                        arr2[trailIdx*3] = bh2.pos.x; arr2[trailIdx*3+1] = bh2.pos.y; arr2[trailIdx*3+2] = bh2.pos.z;
                        trailGeom1.attributes.position.needsUpdate = true;
                        trailGeom2.attributes.position.needsUpdate = true;
                        if (Math.random() > 0.3) trailIdx++;
                    }
                }

                gpuCompute.compute();
                material.uniforms.texturePosition.value = gpuCompute.getCurrentRenderTarget(posVar).texture;
                material.uniforms.textureVelocity.value = gpuCompute.getCurrentRenderTarget(velVar).texture;
            }

            composer.render();
        };
        animate();

        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
            composer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            cleanups.forEach(c => c());
            renderer.dispose();
        };
    }, []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />;
};

export default GalaxyVisualizer;