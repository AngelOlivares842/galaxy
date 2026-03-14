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
    uniform float isBlackHoleMode; 

    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );

        vec3 acc = vec3(0.0);
        
        if (isBlackHoleMode > 0.5) {
            // FIX: El Agujero Negro es indomable. Su gravedad SIEMPRE es 0.15, ignore el slider.
            float blackHoleGravity = 0.15; 
            
            vec3 diff1 = center1 - pos.xyz;
            float distSq1 = dot(diff1, diff1) + softening;
            acc += blackHoleGravity * mass1 * diff1 * pow(distSq1, -1.5);
            acc -= vel.xyz * 0.015; // Fricción orbital
        } else {
            // TU FÍSICA DE COLISIÓN GALÁCTICA EXACTA (SÍ obedece al slider)
            vec3 diff1 = center1 - pos.xyz;
            float distSq1 = dot(diff1, diff1) + softening;
            acc += gravity * mass1 * diff1 * pow(distSq1, -1.5);

            vec3 diff2 = center2 - pos.xyz;
            float distSq2 = dot(diff2, diff2) + softening;
            acc += gravity * mass2 * diff2 * pow(distSq2, -1.5);
        }

        gl_FragColor = vec4( vel.xyz + acc * dt, 1.0 );
    }
`;

const vertexShader = `
    uniform sampler2D texturePosition;
    uniform sampler2D textureVelocity;
    uniform vec3 cameraPos;
    
    varying float vDensity;
    varying float vDoppler;
    varying float vDistToCenter; 

    void main() {
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        float distToCenter = length(pos.xyz);
        vDistToCenter = distToCenter; 
        
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
    uniform float isBlackHoleMode;
    
    varying float vDensity;
    varying float vDoppler;
    varying float vDistToCenter;

    void main() {
        if (isBlackHoleMode > 0.5 && vDistToCenter < 11.5) {
            discard; 
        }

        float r = 0.0, g = 0.0, b = 0.0;
        
        if (isBlackHoleMode > 0.5) {
            if (vDistToCenter < 25.0) { r = 1.0; g = 1.0; b = 1.0; } 
            else if (vDistToCenter < 60.0) { r = 0.4; g = 0.8; b = 1.0; } 
            else if (vDistToCenter < 120.0) { r = 1.0; g = 0.5; b = 0.1; } 
            else { r = 0.5; g = 0.1; b = 0.1; } 
        } else {
            if (vDensity > 0.6) { r = 1.0; g = 1.0; b = 0.9; } 
            else if (vDensity > 0.3) { r = 0.9; g = 0.8; b = 0.6; } 
            else { r = 0.3; g = 0.6; b = 1.0; }
        }

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

        // --- OBJETO 3D AGUJERO NEGRO ESTÁTICO (AHORA CON DISCO GARGANTUA) ---
        const bhGroup = new THREE.Group();
        
        // Esfera negra pura (Horizonte de Sucesos)
        const bhGeometry = new THREE.SphereGeometry(12, 64, 64);
        const bhMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
        const blackHoleMesh = new THREE.Mesh(bhGeometry, bhMaterial);
        bhGroup.add(blackHoleMesh);
        
        // NUEVO: Disco de Acreción Fotorealista con Shader Personalizado
        const diskGeo = new THREE.RingGeometry(12.2, 50, 64, 32);
        const diskMat = new THREE.ShaderMaterial({
            uniforms: {
                color1: { value: new THREE.Color(0xffeecc) }, // Blanco caliente
                color2: { value: new THREE.Color(0xff4400) }  // Rojo fuego
            },
            vertexShader: `
                varying vec3 vPos;
                void main() {
                    vPos = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 color1;
                uniform vec3 color2;
                varying vec3 vPos;
                void main() {
                    float dist = length(vPos);
                    
                    // Degradado de opacidad interior y exterior
                    float alpha = smoothstep(50.0, 25.0, dist) * smoothstep(12.2, 14.0, dist);
                    
                    // Crear estriaciones (anillos de gas) usando ondas
                    float rings = (sin(dist * 0.8) * 0.5 + 0.5) * (sin(dist * 2.0) * 0.5 + 0.5);
                    alpha *= (0.3 + 0.7 * rings);

                    // Temperatura: más caliente cerca del agujero negro
                    float temp = smoothstep(35.0, 12.2, dist);
                    vec3 color = mix(color2, color1, temp);

                    gl_FragColor = vec4(color, alpha * 0.9);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const accretionDisk = new THREE.Mesh(diskGeo, diskMat);
        accretionDisk.rotation.x = Math.PI / 1.8;
        bhGroup.add(accretionDisk);

        scene.add(bhGroup);
        bhGroup.visible = false; 

        let bh1 = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), mass: 1200 };
        let bh2 = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), mass: 1200 };
        
        const gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);
        const dtPosition = gpuCompute.createTexture();
        const dtVelocity = gpuCompute.createTexture();
        const posArray = dtPosition.image.data as Float32Array;
        const velArray = dtVelocity.image.data as Float32Array;

        const generateInitialState = (type1: string, type2: string, mode: string) => {
            
            if (mode === 'blackhole') {
                bhGroup.visible = true;
                bh1.pos.set(0, 0, 0); bh1.vel.set(0, 0, 0); bh1.mass = 6000;
                bh2.mass = 0; 

                for (let i = 0; i < posArray.length; i += 4) {
                    let r = Math.random() * 200 + 20; 
                    let theta = Math.random() * Math.PI * 2;
                    let x = Math.cos(theta) * r;
                    let y = (Math.random() - 0.5) * (r * 0.05); 
                    let z = Math.sin(theta) * r;

                    const vMag = Math.sqrt((0.5 * bh1.mass) / r);
                    let vx = Math.sin(theta) * vMag;
                    let vy = (Math.random() - 0.5) * 0.5;
                    let vz = -Math.cos(theta) * vMag;

                    posArray[i] = x; posArray[i+1] = y; posArray[i+2] = z; posArray[i+3] = 1;
                    velArray[i] = vx; velArray[i+1] = vy; velArray[i+2] = vz; velArray[i+3] = 1;
                }
            } else {
                bhGroup.visible = false;
                
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
                isBlackHoleMode: { value: 0.0 }
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
                
                // Animación del popup divertido
                const popup = document.getElementById('zeroGravityPopup');
                if (currentG === 0.0) {
                    if (popup) popup.classList.add('show-popup');
                } else {
                    if (popup) popup.classList.remove('show-popup');
                }
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
            bindControl('simMode', 'change', () => document.getElementById('resetButton')?.click()),
            bindControl('resetButton', 'click', () => {
                currentMode = (document.getElementById('simMode') as HTMLSelectElement).value;
                const t1 = (document.getElementById('typeGal1') as HTMLSelectElement).value;
                const t2 = (document.getElementById('typeGal2') as HTMLSelectElement).value;
                
                velVar.material.uniforms.isBlackHoleMode.value = currentMode === 'blackhole' ? 1.0 : 0.0;
                material.uniforms.isBlackHoleMode.value = currentMode === 'blackhole' ? 1.0 : 0.0;
                
                generateInitialState(t1, t2, currentMode);
                
                velVar.material.uniforms.mass1.value = bh1.mass;
                velVar.material.uniforms.mass2.value = bh2.mass;
                velVar.material.uniforms.center1.value.copy(bh1.pos);
                velVar.material.uniforms.center2.value.copy(bh2.pos);

                gpuCompute.renderTexture(dtPosition, posVar.renderTargets[0]);
                gpuCompute.renderTexture(dtPosition, posVar.renderTargets[1]);
                gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[0]);
                gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[1]);
            })
        ];

        const animate = () => {
            requestAnimationFrame(animate);
            controls.update();
            material.uniforms.cameraPos.value.copy(camera.position);

            if (bhGroup.visible && !isPausedRef.current) {
                bhGroup.rotation.y += 0.001; // Rotación súper sutil del disco
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