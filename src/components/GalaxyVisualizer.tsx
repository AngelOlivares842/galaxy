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
            float distToSingularity = length(diff1);
            
            if (distToSingularity < 12.0) {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
                return; 
            }

            float effectiveSoftening = 15.0; 
            float distSq1 = dot(diff1, diff1) + effectiveSoftening;
            acc += actualGravity * mass1 * diff1 * pow(distSq1, -1.5);
            acc -= vel.xyz * 0.025; 
        } else {
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
    uniform float isBlackHoleMode;
    uniform vec3 center1; 
    uniform vec3 center2; 
    
    varying float vDensity;
    varying float vDoppler;
    varying float vDistToCenter; 
    varying vec3 vWorldPos; 

    void main() {
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        vWorldPos = pos.xyz;
        
        float distToCenter;
        if (isBlackHoleMode > 0.5) {
            distToCenter = length(pos.xyz); 
        } else {
            float d1 = length(pos.xyz - center1);
            float d2 = length(pos.xyz - center2);
            distToCenter = min(d1, d2);
        }
        
        vDistToCenter = distToCenter; 
        
        vDensity = 1.0 / (1.0 + distToCenter * 0.08);
        vDensity = clamp(vDensity, 0.0, 1.0);
        
        vec3 dirToCamera = normalize(cameraPos - pos.xyz);
        float approachSpeed = dot(vel.xyz, dirToCamera);
        vDoppler = approachSpeed;

        vec4 mvPosition = modelViewMatrix * vec4( pos.xyz, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        
        if (isBlackHoleMode > 0.5 && distToCenter < 12.0) {
            gl_PointSize = 0.0;
        } else {
            // FIX GALAXIAS: Transición de tamaño.
            // Cerca del núcleo (distancia < 5), las partículas son más pequeñas y densas para formar el núcleo brillante.
            // Lejos del núcleo, se expanden para formar nubes de polvo estelar gigantes.
            float sizeMultiplier = smoothstep(2.0, 20.0, distToCenter);
            // Tamaño base pequeño (núcleo) + expansión masiva para el polvo
            float finalSize = 10.0 + (90.0 * sizeMultiplier); 
            
            gl_PointSize = ( finalSize / -mvPosition.z ) * (8.0 / pow(distToCenter + 1.0, 0.2));
        }
    }
`;

const fragmentShader = `
    uniform float useDoppler;
    uniform float isBlackHoleMode;
    uniform vec3 cameraPos;
    
    varying float vDensity;
    varying float vDoppler;
    varying float vDistToCenter;
    varying vec3 vWorldPos;

    void main() {
        if (isBlackHoleMode > 0.5) {
            vec3 dirToStar = normalize(vWorldPos - cameraPos);
            vec3 dirToCenter = -cameraPos; 
            float tca = dot(dirToCenter, dirToStar);
            if (tca > 0.0) {
                float d2 = dot(dirToCenter, dirToCenter) - tca * tca;
                float radius = 12.0; 
                if (d2 < radius * radius) {
                    float thc = sqrt(radius * radius - d2);
                    float t0 = tca - thc; 
                    float distToStar = length(vWorldPos - cameraPos);
                    if (distToStar > t0) {
                        discard; 
                    }
                }
            }
        }

        float r = 0.0, g = 0.0, b = 0.0;
        
        if (isBlackHoleMode > 0.5) {
            if (vDistToCenter < 25.0) { r = 1.0; g = 1.0; b = 1.0; } 
            else if (vDistToCenter < 60.0) { r = 0.4; g = 0.8; b = 1.0; } 
            else if (vDistToCenter < 120.0) { r = 1.0; g = 0.5; b = 0.1; } 
            else { r = 0.5; g = 0.1; b = 0.1; } 
        } else {
            // Colores Galaxia: Núcleo blanco-amarillento, polvo azulado
            if (vDensity > 0.7) { r = 1.0; g = 0.95; b = 0.85; } 
            else if (vDensity > 0.4) { r = 0.9; g = 0.8; b = 0.6; } 
            else { r = 0.4; g = 0.6; b = 1.0; }
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
        
        float dustShape = exp(-distSq * 3.5); 
        
        // FIX GALAXIAS: Transición de opacidad para arreglar el "overflow" del brillo
        // En el núcleo (distancias bajas), las estrellas son opacas. 
        // En los brazos de polvo (distancias altas), son casi transparentes.
        float opacityMultiplier = 1.0 - smoothstep(5.0, 25.0, vDistToCenter);
        // La opacidad base del polvo es muy bajita (0.05). En el núcleo sube a casi 0.8
        float baseAlpha = 0.05 + (0.75 * opacityMultiplier);
        
        float alpha = dustShape * baseAlpha;
        
        if (isBlackHoleMode > 0.5) {
            float fadeOutRadius = 25.0; 
            float eventHorizon = 12.0;
            float distFactor = smoothstep(eventHorizon, fadeOutRadius, vDistToCenter);
            alpha *= distFactor; 
        }
        
        if (alpha < 0.001) discard; 

        gl_FragColor = vec4( r, g, b, alpha );
    }
`;

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

    void main() {
        vec3 pos = cameraPosition;
        vec3 dir = normalize(vWorldPosition - cameraPosition);
        
        float rs = 12.0; 
        
        vec3 color = vec3(0.0);
        float alpha = 0.0;
        
        for(int i = 0; i < 400; i++) {
            float r2 = dot(pos, pos);
            
            if(r2 < rs * rs) {
                alpha = 1.0; 
                break;
            }
            
            if(r2 > 100000000.0) break; 

            float r = sqrt(r2);
            float h = max(0.5, r * 0.015); 

            vec3 nextPos = pos + dir * h;
            
            if(pos.y * nextPos.y <= 0.0) { 
                float t = -pos.y / dir.y;
                vec3 hit = pos + dir * t;
                float hitR = length(hit);
                
                float iscoRadius = rs * 3.0; 
                float outerRadius = rs * 8.0;

                if(hitR > rs && hitR < outerRadius) {
                    float gradient = 0.0;
                    
                    if (hitR < iscoRadius) {
                        gradient = smoothstep(rs, iscoRadius, hitR) * 0.15; 
                    } 
                    else {
                        gradient = 1.0 - smoothstep(iscoRadius, outerRadius, hitR);
                        gradient = pow(gradient, 1.2); 
                    }
                    
                    gradient = max(0.0, gradient);

                    float rings = sin(hitR * 2.0) * 0.5 + 0.5;
                    rings *= sin(hitR * 0.8) * 0.5 + 0.5;
                    float gasDensity = 0.2 + 0.8 * rings; 
                    
                    vec3 hotColor = vec3(1.2, 0.9, 0.6); 
                    vec3 coolColor = vec3(0.8, 0.2, 0.0); 
                    vec3 diskCol = mix(coolColor, hotColor, pow(gradient, 1.5)) * gasDensity;
                    
                    vec3 diskVel = normalize(vec3(-hit.z, 0.0, hit.x)); 
                    float doppler = dot(dir, diskVel) * gradient; 
                    
                    float dopplerFactor = 1.0 + doppler * 3.0; 
                    diskCol *= dopplerFactor;
                    
                    if(doppler > 0.0) {
                        diskCol.b += doppler * 0.8;
                        diskCol.r -= doppler * 0.3;
                    } else {
                        diskCol.r += abs(doppler) * 0.5;
                    }
                    
                    float opacity = 0.9 * gradient;
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

const GalaxyVisualizer = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const isPausedRef = useRef<boolean>(false);

    useEffect(() => {
        if (!containerRef.current) return;

        const WIDTH = 256; 
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000); 
        
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100000);
        camera.position.set(0, 70, 200);

        const renderer = new THREE.WebGLRenderer({ antialias: false });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.toneMapping = THREE.ReinhardToneMapping; 
        containerRef.current.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.maxDistance = 20000; 

        const renderScene = new RenderPass(scene, camera);
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.8, 0.6, 0.15);
        const composer = new EffectComposer(renderer);
        composer.addPass(renderScene);
        composer.addPass(bloomPass);

        const gargantuaGeometry = new THREE.PlaneGeometry(100000, 100000);
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
                    let r = Math.random() * 200 + 40; 
                    let theta = Math.random() * Math.PI * 2;
                    let x = Math.cos(theta) * r;
                    let y = (Math.random() - 0.5) * (r * 0.1); 
                    let z = Math.sin(theta) * r;

                    const vMag = Math.sqrt((0.5 * bh1.mass) / r);
                    let vx = Math.sin(theta) * vMag;
                    let vy = (Math.random() - 0.5) * 0.5;
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
                            // Reducido la dispersión en Y para que el disco galáctico sea más nítido
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
                material.uniforms.center1.value.copy(bh1.pos);
                material.uniforms.center2.value.copy(bh2.pos);

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