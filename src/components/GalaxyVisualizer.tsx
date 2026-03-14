import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
// @ts-ignore
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// --- SHADERS DE FÍSICA ---
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
    uniform float centralMass; // NUEVO: Control de masa para materia oscura
    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );

        vec3 center1 = vec3(-40.0, 0.0, 0.0);
        vec3 center2 = vec3(40.0, 0.0, 0.0);
        vec3 acc = vec3(0.0);
        
        vec3 diff1 = center1 - pos.xyz;
        float distSq1 = dot(diff1, diff1) + softening;
        acc += gravity * centralMass * diff1 * pow(distSq1, -1.5);

        vec3 diff2 = center2 - pos.xyz;
        float distSq2 = dot(diff2, diff2) + softening;
        acc += gravity * centralMass * diff2 * pow(distSq2, -1.5);

        gl_FragColor = vec4( vel.xyz + acc * dt, 1.0 );
    }
`;

// --- SHADERS DE RENDERIZADO ---
const vertexShader = `
    uniform sampler2D texturePosition;
    varying float vDensity;
    void main() {
        vec4 pos = texture2D( texturePosition, uv );
        float distToCenter = length(pos.xyz);
        
        vDensity = 1.0 / (1.0 + distToCenter * 0.05);
        vDensity = clamp(vDensity, 0.0, 1.0);
        
        vec4 mvPosition = modelViewMatrix * vec4( pos.xyz, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = ( 25.0 / -mvPosition.z ) * (8.0 / pow(distToCenter + 1.0, 0.3));
    }
`;

const fragmentShader = `
    varying float vDensity;
    void main() {
        float r = 0.0, g = 0.0, b = 0.0;
        
        if (vDensity > 0.8) {
            r = 1.0; g = 1.0; b = 1.0; 
        } else if (vDensity > 0.5) {
            r = 1.0; g = 0.9; b = 0.6;  
        } else {
            r = 0.5; g = 0.8; b = 1.0;  
        }

        vec2 circCoord = 2.0 * gl_PointCoord - 1.0;
        float distSq = dot(circCoord, circCoord);
        if (distSq > 1.0) discard;
        
        float alpha = pow(1.0 - distSq, 2.0);
        gl_FragColor = vec4( r, g, b, alpha * (0.6 + vDensity * 0.2) );
    }
`;

const GalaxyVisualizer = () => {
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const WIDTH = 256; 
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
        camera.position.set(0, 100, 200);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0x000000, 1);
        containerRef.current.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        const gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);
        const dtPosition = gpuCompute.createTexture();
        const dtVelocity = gpuCompute.createTexture();
        
        const posArray = dtPosition.image.data as Float32Array;
        const velArray = dtVelocity.image.data as Float32Array;

        // Modificamos la función para aceptar un ángulo de inclinación (en radianes)
        const generateInitialState = (tiltAngleRad: number = 0) => {
            const fillGalaxy = (offset: number, center: THREE.Vector3, isTilted: boolean) => {
                for (let i = offset; i < offset + (posArray.length / 2); i += 4) {
                    const r = Math.random() * 50 + 2;
                    const theta = Math.random() * Math.PI * 2;
                    
                    // Coordenadas base (planas)
                    let x = Math.cos(theta) * r;
                    let y = (Math.random() - 0.5) * 4;
                    let z = Math.sin(theta) * r;

                    const v = Math.sqrt((0.5 * 600.0) / r);
                    let vx = Math.sin(theta) * v;
                    let vy = (Math.random() - 0.5) * 1.5;
                    let vz = -Math.cos(theta) * v;

                    // NUEVO: Si está inclinada, aplicamos matriz de rotación sobre el eje X
                    if (isTilted) {
                        const cosA = Math.cos(tiltAngleRad);
                        const sinA = Math.sin(tiltAngleRad);
                        
                        // Rotamos posición
                        const newY = y * cosA - z * sinA;
                        const newZ = y * sinA + z * cosA;
                        y = newY; z = newZ;
                        
                        // Rotamos velocidad para que la órbita siga siendo estable
                        const newVy = vy * cosA - vz * sinA;
                        const newVz = vy * sinA + vz * cosA;
                        vy = newVy; vz = newVz;
                    }

                    // Aplicamos el centro después de rotar
                    posArray[i] = x + center.x;
                    posArray[i + 1] = y + center.y;
                    posArray[i + 2] = z + center.z;
                    posArray[i + 3] = 1;

                    velArray[i] = vx;
                    velArray[i + 1] = vy;
                    velArray[i + 2] = vz;
                    velArray[i + 3] = 1;
                }
            };

            // Galaxia 1 plana, Galaxia 2 inclinada
            fillGalaxy(0, new THREE.Vector3(-50, 0, 0), false);
            fillGalaxy(posArray.length / 2, new THREE.Vector3(50, 0, 0), true);
        };

        generateInitialState(0); // Iniciamos con 0 grados

        const posVar = gpuCompute.addVariable("texturePosition", computationShaderPosition, dtPosition);
        const velVar = gpuCompute.addVariable("textureVelocity", computationShaderVelocity, dtVelocity);
        gpuCompute.setVariableDependencies(posVar, [posVar, velVar]);
        gpuCompute.setVariableDependencies(velVar, [posVar, velVar]);
        
        posVar.material.uniforms.dt = { value: 0.016 };
        velVar.material.uniforms.dt = { value: 0.016 };
        velVar.material.uniforms.gravity = { value: 0.15 };
        velVar.material.uniforms.softening = { value: 3.5 };
        // Masa con Materia Oscura activada por defecto
        velVar.material.uniforms.centralMass = { value: 1200.0 }; 
        
        gpuCompute.init();

        // --- CONEXIÓN DE CONTROLES HTML ---
        const gravitySlider = document.getElementById('gravitySlider') as HTMLInputElement;
        const gravityDisplay = document.getElementById('gravityValueDisplay');
        const timeSlider = document.getElementById('timeSlider') as HTMLInputElement;
        const timeDisplay = document.getElementById('timeValueDisplay');
        const angleSlider = document.getElementById('angleSlider') as HTMLInputElement;
        const angleDisplay = document.getElementById('angleValueDisplay');
        const dmToggle = document.getElementById('darkMatterToggle') as HTMLInputElement;
        const resetButton = document.getElementById('resetButton');

        if (gravitySlider) gravitySlider.addEventListener('input', (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            if (gravityDisplay) gravityDisplay.innerText = val.toFixed(2);
            velVar.material.uniforms.gravity.value = val; 
        });

        if (timeSlider) timeSlider.addEventListener('input', (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            if (timeDisplay) timeDisplay.innerText = val.toFixed(3);
            posVar.material.uniforms.dt.value = val; 
            velVar.material.uniforms.dt.value = val; 
        });

        if (dmToggle) dmToggle.addEventListener('change', (e) => {
            const isChecked = (e.target as HTMLInputElement).checked;
            // Si hay materia oscura la masa es alta, si no, es baja (las estrellas se dispersan)
            velVar.material.uniforms.centralMass.value = isChecked ? 1200.0 : 300.0;
        });

        const handleReset = () => {
            // Leer el ángulo del slider
            let angleDeg = 0;
            if (angleSlider) {
                angleDeg = parseFloat(angleSlider.value);
                if (angleDisplay) angleDisplay.innerText = angleDeg + "°";
            }
            const angleRad = angleDeg * (Math.PI / 180);

            generateInitialState(angleRad);
            gpuCompute.renderTexture(dtPosition, posVar.renderTargets[0]);
            gpuCompute.renderTexture(dtPosition, posVar.renderTargets[1]);
            gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[0]);
            gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[1]);
        };

        // Si cambian el ángulo, reiniciamos automáticamente para aplicar la rotación inicial
        if (angleSlider) angleSlider.addEventListener('input', handleReset);
        if (resetButton) resetButton.addEventListener('click', handleReset);

        // --- RENDER DE PARTÍCULAS ---
        const geometry = new THREE.BufferGeometry();
        const uvs = new Float32Array(WIDTH * WIDTH * 2);
        for (let i = 0; i < WIDTH * WIDTH; i++) {
            uvs[i * 2] = (i % WIDTH) / WIDTH;
            uvs[i * 2 + 1] = Math.floor(i / WIDTH) / WIDTH;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WIDTH * WIDTH * 3), 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

        const material = new THREE.ShaderMaterial({
            uniforms: { texturePosition: { value: null } },
            vertexShader,
            fragmentShader,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        const points = new THREE.Points(geometry, material);
        scene.add(points);

        const animate = () => {
            requestAnimationFrame(animate);
            gpuCompute.compute();
            material.uniforms.texturePosition.value = gpuCompute.getCurrentRenderTarget(posVar).texture;
            controls.update();
            renderer.render(scene, camera);
        };
        animate();

        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            renderer.dispose();
        };
    }, []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />;
};

export default GalaxyVisualizer;