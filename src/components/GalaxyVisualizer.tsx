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

// ============================================================================
// 1. SHADERS DE CÓMPUTO (GPGPU) - MOTOR FÍSICO N-BODY 1 MILLÓN DE PARTÍCULAS
// ============================================================================

const computationShaderPosition = `
    uniform float dt; 
    
    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        
        if (length(vel.xyz) == 0.0) {
            gl_FragColor = pos;
        } else {
            gl_FragColor = vec4( pos.xyz + vel.xyz * dt, 1.0 );
        }
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
    uniform float isBlackHoleMode; 

    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        vec3 acc = vec3(0.0); 
        
        if (isBlackHoleMode > 0.5) {
            float actualGravity = max(gravity, 0.08); 
            vec3 diff1 = center1 - pos.xyz;
            float distSq = dot(diff1, diff1);
            
            if (distSq < 144.0) { // dist < 12.0
                gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
                return; 
            }

            float invDist = inversesqrt(distSq + 15.0); 
            float invDistCube = invDist * invDist * invDist;
            
            acc += actualGravity * mass1 * diff1 * invDistCube;
            acc -= vel.xyz * 0.015; 
        } else {
            vec3 diff1 = center1 - pos.xyz;
            float distSq1 = dot(diff1, diff1) + softening;
            float invDistCube1 = inversesqrt(distSq1) / distSq1;
            acc += gravity * mass1 * diff1 * invDistCube1;

            vec3 diff2 = center2 - pos.xyz;
            float distSq2 = dot(diff2, diff2) + softening;
            float invDistCube2 = inversesqrt(distSq2) / distSq2;
            acc += gravity * mass2 * diff2 * invDistCube2;
        }

        gl_FragColor = vec4( vel.xyz + acc * dt, 1.0 );
    }
`;

// ============================================================================
// 2. SHADERS DE MATERIAL (RENDERIZADO VOLUMÉTRICO MILLION-PARTICLE)
// ============================================================================

const vertexShader = `
    uniform sampler2D texturePosition; 
    uniform sampler2D textureVelocity; 
    uniform vec3 cameraPos; 
    uniform float isBlackHoleMode;
    uniform vec3 center1; 
    uniform vec3 center2; 
    
    varying float vDoppler;
    varying float vDistToCenter; 

    void main() {
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        
        float distToCenter;
        if (isBlackHoleMode > 0.5) {
            distToCenter = length(pos.xyz); 
        } else {
            float d1 = length(pos.xyz - center1);
            float d2 = length(pos.xyz - center2);
            distToCenter = min(d1, d2); 
        }
        
        vDistToCenter = distToCenter; 
        
        vec3 dirToCamera = normalize(cameraPos - pos.xyz);
        float approachSpeed = dot(vel.xyz, dirToCamera);
        vDoppler = approachSpeed;

        vec4 mvPosition = modelViewMatrix * vec4( pos.xyz, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        
        if (isBlackHoleMode > 0.5 && distToCenter < 12.0) {
            gl_PointSize = 0.0;
        } else {
            gl_PointSize = ( 20.0 / -mvPosition.z );
        }
    }
`;

const fragmentShader = `
    uniform float useDoppler;
    uniform float isBlackHoleMode;
    
    varying float vDoppler;
    varying float vDistToCenter;

    void main() {
        if (isBlackHoleMode > 0.5 && vDistToCenter < 22.0) {
            discard; 
        }

        vec3 color;
        if (isBlackHoleMode > 0.5) {
            vec3 hotCenter = vec3(0.6, 0.8, 1.0);
            vec3 warmMid = vec3(1.0, 0.5, 0.1);
            vec3 coldEdge = vec3(0.3, 0.05, 0.0);
            
            if (vDistToCenter < 60.0) {
                color = mix(hotCenter, warmMid, smoothstep(22.0, 60.0, vDistToCenter));
            } else {
                color = mix(warmMid, coldEdge, smoothstep(60.0, 150.0, vDistToCenter));
            }
        } else {
            color = mix(vec3(1.0, 0.9, 0.7), vec3(0.2, 0.4, 0.8), smoothstep(0.0, 80.0, vDistToCenter));
        }

        if (useDoppler > 0.5) {
            float shift = clamp(vDoppler * 0.1, -0.8, 0.8);
            if (shift > 0.0) {
                color.b += shift; color.r -= shift * 0.5; 
            } else {
                color.r += abs(shift); color.b -= abs(shift) * 0.5; 
            }
        }

        vec2 circCoord = 2.0 * gl_PointCoord - 1.0;
        float distSq = dot(circCoord, circCoord);
        if (distSq > 1.0) discard; 
        
        float alpha = exp(-distSq * 3.0) * 0.015; 
        
        if (isBlackHoleMode > 0.5) {
            alpha *= smoothstep(22.0, 45.0, vDistToCenter); 
        }
        
        if (alpha < 0.001) discard; 

        gl_FragColor = vec4( color, alpha );
    }
`;

// ============================================================================
// 3. SHADERS DEL AGUJERO NEGRO (LENTE GRAVITACIONAL ACOTADO) - FÍSICA MEJORADA
// ============================================================================

const gargantuaVertexShader = `
    varying vec3 vWorldPosition;
    
    void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
`;

const gargantuaFragmentShader = `
    varying vec3 vWorldPosition;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
        vec3 pos = cameraPosition;
        vec3 dir = normalize(vWorldPosition - cameraPosition);
        
        float rs = 12.0; 
        vec3 color = vec3(0.0);
        float alpha = 0.0;
        
        for(int i = 0; i < 250; i++) { 
            float r2 = dot(pos, pos);
            
            if(r2 < rs * rs * 1.02) {
                alpha = 1.0; 
                break;
            }
            
            float r = sqrt(r2);
            float h = max(0.5, r * 0.02); 

            vec3 nextPos = pos + dir * h; 
            
            if(pos.y * nextPos.y <= 0.0) { 
                float t = -pos.y / dir.y;
                vec3 hit = pos + dir * t; 
                float hitR = length(hit);
                
                float iscoRadius = rs * 3.0; 
                float outerRadius = rs * 8.0; 

                if(hitR > rs * 1.2 && hitR < outerRadius) {
                    
                    float temp;
                    if(hitR < iscoRadius) {
                        temp = smoothstep(rs * 1.2, iscoRadius, hitR);
                    } else {
                        temp = 1.0 - smoothstep(iscoRadius, outerRadius, hitR);
                    }
                    temp = pow(temp, 1.2); 
                    
                    vec3 colCold = vec3(0.1, 0.0, 0.0);       
                    vec3 colWarm = vec3(0.9, 0.3, 0.0);       
                    vec3 colHot = vec3(1.0, 0.9, 0.7);        
                    vec3 colCorona = vec3(0.7, 0.9, 1.0);     
                    
                    vec3 diskCol;
                    if (temp < 0.4) diskCol = mix(colCold, colWarm, temp / 0.4);
                    else if (temp < 0.8) diskCol = mix(colWarm, colHot, (temp - 0.4) / 0.4);
                    else diskCol = mix(colHot, colCorona, (temp - 0.8) / 0.2);
                    
                    float gasNoise = mix(0.8, 1.0, hash(hit.xz * 0.5));
                    diskCol *= gasNoise;
                    
                    // FIX VISUAL: Control del Beaming Relativista para pantallas
                    vec3 diskVel = normalize(vec3(-hit.z, 0.0, hit.x)); 
                    float orbitalSpeed = sqrt(rs / (2.0 * hitR)); 
                    float approach = dot(dir, diskVel) * orbitalSpeed * 1.5; 
                    
                    // Limitamos el factor Doppler para no "quemar" la imagen a blanco puro
                    float dopplerFactor = max(0.2, 1.0 + approach * 0.8);
                    float beaming = pow(dopplerFactor, 2.0); // D^2 en lugar de D^3
                    
                    // Cortafuegos de brillo máximo (Clamp)
                    diskCol *= clamp(beaming, 0.1, 2.2);
                    
                    if(approach > 0.0) { 
                        diskCol = mix(diskCol, vec3(0.5, 0.8, 1.0), approach * 0.5); 
                    } else { 
                        diskCol = mix(diskCol, vec3(0.8, 0.1, 0.0), abs(approach) * 0.5); 
                    }
                    
                    float opacity = 0.85 * temp;
                    color += diskCol * (1.0 - alpha) * opacity;
                    alpha += opacity * (1.0 - alpha);
                }
            }
            
            float x_dot_v = dot(pos, dir);
            float L2 = r2 - x_dot_v * x_dot_v; 
            vec3 accel = -1.5 * rs * L2 / (r2 * r2 * r) * pos; 
            
            dir = normalize(dir + accel * h); 
            pos = nextPos;
        }

        if (alpha < 0.01) discard; 
        gl_FragColor = vec4(color, alpha);
    }
`;

// ============================================================================
// 4. COMPONENTE REACT PRINCIPAL (ORQUESTADOR)
// ============================================================================

const GalaxyVisualizer = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const isPausedRef = useRef<boolean>(false);

    useEffect(() => {
        if (!containerRef.current) return;
        let animationFrameId: number;

        const WIDTH = 1024; 
        
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000); 
        
        const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 100000);
        camera.position.set(0, 100, 250);

        const renderer = new THREE.WebGLRenderer({ antialias: false }); 
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); 
        renderer.toneMapping = THREE.ACESFilmicToneMapping; 
        // FIX VISUAL: Bajamos la exposición del entorno para que los brillos destaquen sin saturar
        renderer.toneMappingExposure = 1.0; 
        containerRef.current.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.maxDistance = 20000; 

        const renderScene = new RenderPass(scene, camera);
        // FIX VISUAL: Ajustamos el Bloom. Intensidad bajada de 1.5 a 0.8, y el threshold subido
        // para que solo las partes hiper-calientes brillen como neón, preservando la textura.
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.8, 0.4, 0.4);
        const composer = new EffectComposer(renderer);
        composer.addPass(renderScene);
        composer.addPass(bloomPass);

        const gargantuaGeometry = new THREE.PlaneGeometry(800, 800);
        const gargantuaMaterial = new THREE.ShaderMaterial({
            vertexShader: gargantuaVertexShader,
            fragmentShader: gargantuaFragmentShader,
            transparent: true,
            depthWrite: false, 
            blending: THREE.NormalBlending
        });
        const gargantuaMesh = new THREE.Mesh(gargantuaGeometry, gargantuaMaterial);
        scene.add(gargantuaMesh);
        gargantuaMesh.visible = false; 

        let bh1 = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), mass: 1200 };
        let bh2 = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), mass: 1200 };
        
        const gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);
        const dtPosition = gpuCompute.createTexture();
        const dtVelocity = gpuCompute.createTexture();
        const posArray = dtPosition.image.data as Float32Array;
        const velArray = dtVelocity.image.data as Float32Array;

        const generateInitialState = (type1: string, type2: string, mode: string) => {
            if (mode === 'blackhole') {
                gargantuaMesh.visible = true;
                bh1.pos.set(0, 0, 0); bh1.vel.set(0, 0, 0); bh1.mass = 6000;
                bh2.mass = 0; 

                for (let i = 0; i < posArray.length; i += 4) {
                    let r = Math.random() * 250 + 25; 
                    let theta = Math.random() * Math.PI * 2;
                    let x = Math.cos(theta) * r;
                    let y = (Math.random() - 0.5) * (r * 0.05); 
                    let z = Math.sin(theta) * r;

                    const vMag = Math.sqrt((0.5 * bh1.mass) / r);
                    let vx = Math.sin(theta) * vMag;
                    let vy = (Math.random() - 0.5) * 0.1;
                    let vz = -Math.cos(theta) * vMag;

                    posArray[i] = x; posArray[i+1] = y; posArray[i+2] = z; posArray[i+3] = 1;
                    velArray[i] = vx; velArray[i+1] = vy; velArray[i+2] = vz; velArray[i+3] = 1;
                }
            } else {
                gargantuaMesh.visible = false;
                bh1.pos.set(-80, 0, -20); bh1.vel.set(2.0, 0, 0.5); bh1.mass = 1200;
                bh2.pos.set(80, 0, 20);   bh2.vel.set(-2.0, 0, -0.5); bh2.mass = type2 === 'dwarf' ? 300 : 1200;

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
                            y = (Math.random() - 0.5) * 2.5; 
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
            }
        };

        let currentMode = 'galaxy';
        generateInitialState('spiral', 'spiral', currentMode);

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
        velVar.material.uniforms.isBlackHoleMode = { value: 0.0 };
        
        gpuCompute.init();

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
                useDoppler: { value: 1.0 },
                isBlackHoleMode: { value: 0.0 },
                center1: { value: bh1.pos },
                center2: { value: bh2.pos } 
            },
            vertexShader,
            fragmentShader,
            transparent: true,
            blending: THREE.AdditiveBlending, 
            depthWrite: false, 
            depthTest: true 
        });

        const points = new THREE.Points(geometry, material);
        scene.add(points);

        const getSafeElement = (id: string) => document.getElementById(id);
        const bindControl = (id: string, event: string, handler: (e: any) => void) => {
            const el = getSafeElement(id);
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
                const disp = getSafeElement('gravityValueDisplay');
                if (disp) disp.innerText = currentG.toFixed(2);
                velVar.material.uniforms.gravity.value = currentG;
            }),
            bindControl('timeSlider', 'input', (e) => {
                currentDt = parseFloat(e.target.value);
                const disp = getSafeElement('timeValueDisplay');
                if (disp) disp.innerText = currentDt.toFixed(3);
                posVar.material.uniforms.dt.value = currentDt;
                velVar.material.uniforms.dt.value = currentDt;
            }),
            bindControl('dopplerToggle', 'change', (e) => {
                material.uniforms.useDoppler.value = e.target.checked ? 1.0 : 0.0;
            }),
            bindControl('simMode', 'change', () => getSafeElement('resetButton')?.click()),
            bindControl('resetButton', 'click', () => {
                const modeEl = getSafeElement('simMode') as HTMLSelectElement;
                const t1El = getSafeElement('typeGal1') as HTMLSelectElement;
                const t2El = getSafeElement('typeGal2') as HTMLSelectElement;
                
                currentMode = modeEl ? modeEl.value : 'galaxy';
                const t1 = t1El ? t1El.value : 'spiral';
                const t2 = t2El ? t2El.value : 'spiral';
                
                const isBH = currentMode === 'blackhole' ? 1.0 : 0.0;
                velVar.material.uniforms.isBlackHoleMode.value = isBH;
                material.uniforms.isBlackHoleMode.value = isBH;
                
                generateInitialState(t1, t2, currentMode);
                
                velVar.material.uniforms.mass1.value = bh1.mass;
                velVar.material.uniforms.mass2.value = bh2.mass;
                velVar.material.uniforms.center1.value.copy(bh1.pos);
                velVar.material.uniforms.center2.value.copy(bh2.pos);
                material.uniforms.center1.value.copy(bh1.pos);
                material.uniforms.center2.value.copy(bh2.pos);

                gpuCompute.renderTexture(dtPosition, posVar.renderTargets[0]);
                gpuCompute.renderTexture(dtPosition, posVar.renderTargets[1]);
                gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[0]);
                gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[1]);
            })
        ];

        let frameCount = 0;
        let lastTime = performance.now();

        const animate = () => {
            animationFrameId = requestAnimationFrame(animate);
            controls.update();
            material.uniforms.cameraPos.value.copy(camera.position);

            if (gargantuaMesh.visible) {
                gargantuaMesh.lookAt(camera.position);
            }

            if (!isPausedRef.current) {
                if (currentMode === 'galaxy') {
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
                    material.uniforms.center1.value.copy(bh1.pos);
                    material.uniforms.center2.value.copy(bh2.pos);
                }

                gpuCompute.compute();
                material.uniforms.texturePosition.value = gpuCompute.getCurrentRenderTarget(posVar).texture;
                material.uniforms.textureVelocity.value = gpuCompute.getCurrentRenderTarget(velVar).texture;
            }

            composer.render();

            frameCount++;
            const now = performance.now();
            if (now - lastTime >= 1000) { 
                const fps = frameCount;
                const hudFps = getSafeElement('hud-fps');
                if (hudFps) {
                    hudFps.innerText = `${fps} FPS`;
                    hudFps.style.color = fps >= 55 ? '#34d399' : (fps >= 30 ? '#facc15' : '#ef4444');
                }

                const elEntities = getSafeElement('hud-entities');
                if (elEntities) elEntities.innerText = (WIDTH * WIDTH).toLocaleString();

                let gflops = 0;
                const particlesFlops = (WIDTH * WIDTH) * 40 * fps; 
                
                if (currentMode === 'blackhole') {
                    const raymarchingFlops = window.innerWidth * window.innerHeight * 100 * 50 * fps;
                    gflops = (particlesFlops + raymarchingFlops) / 1e9;
                    
                    const safeSet = (id: string, val: string) => { const el = getSafeElement(id); if(el) el.innerText = val; };
                    safeSet('hud-ray-steps', 'Activada (Lente Grav.)');
                    safeSet('hud-mass', '6.0 x 10^6 M☉');
                    safeSet('hud-rs', '12.0 u');
                    safeSet('hud-photon', '18.0 u');
                    safeSet('hud-isco', '36.0 u');
                    
                    const dilation = Math.sqrt(1 - (12.0 / 36.0));
                    safeSet('hud-dilation', `${dilation.toFixed(4)}x`);
                } else {
                    gflops = particlesFlops / 1e9;
                    const safeSet = (id: string, val: string) => { const el = getSafeElement(id); if(el) el.innerText = val; };
                    safeSet('hud-ray-steps', 'Inactiva');
                    safeSet('hud-mass', 'Sistema Binario');
                    safeSet('hud-rs', 'N/A');
                    safeSet('hud-photon', 'N/A');
                    safeSet('hud-isco', 'N/A');
                    safeSet('hud-dilation', '1.0000x');
                }
                
                const elFlops = getSafeElement('hud-flops');
                if(elFlops) elFlops.innerText = `${gflops.toFixed(2)} GFLOPs`;
                
                frameCount = 0;
                lastTime = now;
            }
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
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', handleResize);
            cleanups.forEach(c => c());
            renderer.dispose();
            if (containerRef.current && renderer.domElement) {
                containerRef.current.removeChild(renderer.domElement);
            }
        };
    }, []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />;
};

export default GalaxyVisualizer;