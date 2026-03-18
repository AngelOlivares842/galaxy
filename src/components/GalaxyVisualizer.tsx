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
// 1. SHADERS DE CÓMPUTO (GPGPU) - MOTOR FÍSICO N-BODY
// Estos shaders se ejecutan en texturas de datos para procesar la física 
// de miles de partículas en paralelo directamente en la tarjeta gráfica.
// ============================================================================

const computationShaderPosition = `
    uniform float dt; // Delta time (paso de tiempo de la simulación)
    
    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        
        // Si la velocidad es exactamente 0, la partícula ha sido absorbida por 
        // el agujero negro. Congelamos su posición para evitar cálculos innecesarios.
        if (length(vel.xyz) == 0.0) {
            gl_FragColor = pos;
        } else {
            // Integración de Euler básica: Nueva Posición = Posición Actual + (Velocidad * Tiempo)
            gl_FragColor = vec4( pos.xyz + vel.xyz * dt, 1.0 );
        }
    }
`;

const computationShaderVelocity = `
    uniform float gravity; // Constante gravitacional base
    uniform float softening; // Parámetro de suavizado de Plummer para evitar fuerzas infinitas
    uniform float dt; // Delta time
    uniform float mass1; // Masa del centro gravitatorio 1
    uniform float mass2; // Masa del centro gravitatorio 2
    uniform vec3 center1; // Posición dinámica del centro 1
    uniform vec3 center2; // Posición dinámica del centro 2
    uniform float isBlackHoleMode; // Flag (1.0 = Agujero Negro, 0.0 = Galaxias)

    void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        vec3 acc = vec3(0.0); // Vector de aceleración resultante
        
        if (isBlackHoleMode > 0.5) {
            // --- MODO AGUJERO NEGRO ---
            float actualGravity = max(gravity, 0.08); // Gravedad mínima garantizada
            vec3 diff1 = center1 - pos.xyz;
            float distToSingularity = length(diff1);
            
            // Condición de Acreción: Si la partícula cruza el Radio de Schwarzschild (Rs = 12.0)
            if (distToSingularity < 12.0) {
                // Anulamos su velocidad. Físicamente deja de existir en el espacio exterior.
                gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
                return; 
            }

            // Aplicamos un softening mayor cerca de la singularidad para estabilizar la órbita
            float effectiveSoftening = 15.0; 
            float distSq1 = dot(diff1, diff1) + effectiveSoftening;
            
            // Ley de Gravitación Universal de Newton (vectorizada y suavizada)
            acc += actualGravity * mass1 * diff1 * pow(distSq1, -1.5);
            // Fricción cinemática orbital simulando pérdida de energía térmica en el disco
            acc -= vel.xyz * 0.025; 
        } else {
            // --- MODO COLISIÓN GALÁCTICA N-BODY ---
            // Interacción gravitatoria con el primer núcleo galáctico
            vec3 diff1 = center1 - pos.xyz;
            float distSq1 = dot(diff1, diff1) + softening;
            acc += gravity * mass1 * diff1 * pow(distSq1, -1.5);

            // Interacción gravitatoria con el segundo núcleo galáctico
            vec3 diff2 = center2 - pos.xyz;
            float distSq2 = dot(diff2, diff2) + softening;
            acc += gravity * mass2 * diff2 * pow(distSq2, -1.5);
        }

        // Actualización de velocidad: Nueva Velocidad = Velocidad Actual + (Aceleración * Tiempo)
        gl_FragColor = vec4( vel.xyz + acc * dt, 1.0 );
    }
`;

// ============================================================================
// 2. SHADERS DE MATERIAL (RENDERIZADO DE PARTÍCULAS / GAS)
// Estos shaders dictan cómo se dibuja visualmente cada partícula calculada por el GPGPU.
// ============================================================================

const vertexShader = `
    uniform sampler2D texturePosition; // Textura GPGPU con las posiciones actuales
    uniform sampler2D textureVelocity; // Textura GPGPU con las velocidades actuales
    uniform vec3 cameraPos; // Posición de la cámara para cálculos de oclusión y Doppler
    uniform float isBlackHoleMode;
    uniform vec3 center1; // Núcleo dinámico de Galaxia 1
    uniform vec3 center2; // Núcleo dinámico de Galaxia 2
    
    // Varyings para pasar datos interpolados al Fragment Shader
    varying float vDensity;
    varying float vDoppler;
    varying float vDistToCenter; 
    varying vec3 vWorldPos; 

    void main() {
        vec4 pos = texture2D( texturePosition, uv );
        vec4 vel = texture2D( textureVelocity, uv );
        vWorldPos = pos.xyz;
        
        // Cálculo de distancia al centro de gravedad relevante (dinámico para galaxias)
        float distToCenter;
        if (isBlackHoleMode > 0.5) {
            distToCenter = length(pos.xyz); // Singularidad estática en (0,0,0)
        } else {
            float d1 = length(pos.xyz - center1);
            float d2 = length(pos.xyz - center2);
            distToCenter = min(d1, d2); // Se vincula al núcleo más cercano
        }
        
        vDistToCenter = distToCenter; 
        
        // Mapeo de densidad (usado para colorear: más cerca = más denso/brillante)
        vDensity = 1.0 / (1.0 + distToCenter * 0.08);
        vDensity = clamp(vDensity, 0.0, 1.0);
        
        // Cálculo de Relativistic Beaming (Efecto Doppler)
        // Obtenemos la velocidad de acercamiento hacia la cámara mediante el producto punto
        vec3 dirToCamera = normalize(cameraPos - pos.xyz);
        float approachSpeed = dot(vel.xyz, dirToCamera);
        vDoppler = approachSpeed;

        // Proyección estándar WebGL a coordenadas de pantalla
        vec4 mvPosition = modelViewMatrix * vec4( pos.xyz, 1.0 );
        gl_Position = projectionMatrix * mvPosition;
        
        // Control dinámico del tamaño del PointSprite
        if (isBlackHoleMode > 0.5 && distToCenter < 12.0) {
            // Ocultar partículas devoradas (Radio de Schwarzschild = 12.0)
            gl_PointSize = 0.0;
        } else {
            // Transición morfológica: 
            // Las partículas en el núcleo son pequeñas (simulando estrellas densas).
            // Las partículas exteriores se expanden masivamente para simular nubes de gas.
            float sizeMultiplier = smoothstep(2.0, 20.0, distToCenter);
            float finalSize = 10.0 + (90.0 * sizeMultiplier); // 10px (núcleo) a 100px (polvo)
            
            // Atenuación de perspectiva (más pequeño si está más lejos)
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
        // Oclusión de Rayos (Ray-Sphere Intersection)
        // Detecta si la estrella se encuentra físicamente "detrás" de la esfera del horizonte 
        // de sucesos desde el punto de vista de la cámara, para evitar que se renderice encima.
        if (isBlackHoleMode > 0.5) {
            vec3 dirToStar = normalize(vWorldPos - cameraPos);
            vec3 dirToCenter = -cameraPos; 
            float tca = dot(dirToCenter, dirToStar);
            if (tca > 0.0) {
                float d2 = dot(dirToCenter, dirToCenter) - tca * tca;
                float radius = 12.0; // Radio del Horizonte
                if (d2 < radius * radius) {
                    float thc = sqrt(radius * radius - d2);
                    float t0 = tca - thc; 
                    float distToStar = length(vWorldPos - cameraPos);
                    // Si la distancia a la estrella es mayor que la distancia a la esfera oscura: descartar.
                    if (distToStar > t0) {
                        discard; 
                    }
                }
            }
        }

        // Asignación base de colores (Espectro Térmico)
        float r = 0.0, g = 0.0, b = 0.0;
        
        if (isBlackHoleMode > 0.5) {
            // Colores de materia cayendo al Agujero Negro (más blanco/azul cerca, rojo lejos)
            if (vDistToCenter < 25.0) { r = 1.0; g = 1.0; b = 1.0; } 
            else if (vDistToCenter < 60.0) { r = 0.4; g = 0.8; b = 1.0; } 
            else if (vDistToCenter < 120.0) { r = 1.0; g = 0.5; b = 0.1; } 
            else { r = 0.5; g = 0.1; b = 0.1; } 
        } else {
            // Colores para Colisión Galáctica (Núcleo cálido, brazos espirales azules)
            if (vDensity > 0.7) { r = 1.0; g = 0.95; b = 0.85; } 
            else if (vDensity > 0.4) { r = 0.9; g = 0.8; b = 0.6; } 
            else { r = 0.4; g = 0.6; b = 1.0; }
        }

        // Aplicación de Corrimiento al Rojo/Azul (Doppler Relativista o Clásico)
        if (useDoppler > 0.5) {
            float shift = clamp(vDoppler * 0.08, -0.6, 0.6);
            if (shift > 0.0) {
                // Se acerca -> Corrimiento al Azul (Blueshift)
                b += shift; r -= shift * 0.5;
            } else {
                // Se aleja -> Corrimiento al Rojo (Redshift)
                r += abs(shift); b -= abs(shift) * 0.5;
            }
        }

        // Conversión de textura cuadrada a circular
        vec2 circCoord = 2.0 * gl_PointCoord - 1.0;
        float distSq = dot(circCoord, circCoord);
        if (distSq > 1.0) discard; 
        
        // Simulación de Polvo Volumétrico (Gaussian Falloff)
        // Genera un borde ultra-difuminado que, sumado por Additive Blending, crea nubes de gas.
        float dustShape = exp(-distSq * 3.5); 
        
        // Transición de opacidad espacial
        // Núcleos densos (distancia < 5.0) son opacos para evitar overflow matemático del Bloom.
        // Brazos lejanos son extremadamente translúcidos (0.05).
        float opacityMultiplier = 1.0 - smoothstep(5.0, 25.0, vDistToCenter);
        float baseAlpha = 0.05 + (0.75 * opacityMultiplier);
        
        float alpha = dustShape * baseAlpha;
        
        // Plasma Fade-Out: Transición de partículas discretas a continuo térmico
        // Desvanece el gas antes de tocar el horizonte, cediendo protagonismo al shader de Gargantua.
        if (isBlackHoleMode > 0.5) {
            float fadeOutRadius = 25.0; 
            float eventHorizon = 12.0;
            float distFactor = smoothstep(eventHorizon, fadeOutRadius, vDistToCenter);
            alpha *= distFactor; 
        }
        
        // Optimización: No renderizar píxeles casi invisibles
        if (alpha < 0.001) discard; 

        gl_FragColor = vec4( r, g, b, alpha );
    }
`;

// ============================================================================
// 3. SHADERS DEL AGUJERO NEGRO (RAYMARCHING RELATIVISTA)
// Proyecta un lienzo invisible y traza rayos de luz a través de un espacio-tiempo
// curvado definido por la métrica de Schwarzschild.
// ============================================================================

const gargantuaVertexShader = `
    varying vec3 vWorldPosition;
    
    void main() {
        // Obtenemos la coordenada absoluta del lienzo en el espacio 3D
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
`;

const gargantuaFragmentShader = `
    varying vec3 vWorldPosition;

    void main() {
        vec3 pos = cameraPosition;
        // Vector direccional del rayo de luz simulado (fotón)
        vec3 dir = normalize(vWorldPosition - cameraPosition);
        
        float rs = 12.0; // Radio de Schwarzschild
        
        vec3 color = vec3(0.0);
        float alpha = 0.0;
        
        // Bucle Principal de Integración del Raymarcher (Geodésica Nula)
        for(int i = 0; i < 400; i++) {
            float r2 = dot(pos, pos);
            
            // Si el rayo cruza el horizonte de sucesos, es absorbido (negro absoluto)
            if(r2 < rs * rs) {
                alpha = 1.0; 
                break;
            }
            
            // Condición de escape: Si el rayo se aleja demasiado, dejamos de calcular
            if(r2 > 100000000.0) break; 

            float r = sqrt(r2);
            // Adaptive Ray Stepping: Pasos grandes lejos del centro, pasos milimétricos cerca
            float h = max(0.5, r * 0.015); 

            vec3 nextPos = pos + dir * h;
            
            // Detección de intersección con el plano del Disco de Acreción (Y=0)
            if(pos.y * nextPos.y <= 0.0) { 
                float t = -pos.y / dir.y;
                vec3 hit = pos + dir * t; // Coordenada exacta de colisión en el disco
                float hitR = length(hit);
                
                // Definición de las zonas anatómicas del Disco de Acreción
                float iscoRadius = rs * 3.0; // ISCO (Innermost Stable Circular Orbit)
                float outerRadius = rs * 8.0; // Límite exterior del plasma visible

                // Si el rayo cruza a través del gas incandescente
                if(hitR > rs && hitR < outerRadius) {
                    float gradient = 0.0;
                    
                    // Zona de caída libre térmica (dentro de ISCO): Brillo residual mínimo
                    if (hitR < iscoRadius) {
                        gradient = smoothstep(rs, iscoRadius, hitR) * 0.15; 
                    } 
                    // Zona del disco estable principal: Brillo máximo con perfil de potencia
                    else {
                        gradient = 1.0 - smoothstep(iscoRadius, outerRadius, hitR);
                        gradient = pow(gradient, 1.2); 
                    }
                    
                    gradient = max(0.0, gradient);

                    // Estriaciones de gas modeladas mediante funciones armónicas (ruido de baja frec)
                    float rings = sin(hitR * 2.0) * 0.5 + 0.5;
                    rings *= sin(hitR * 0.8) * 0.5 + 0.5;
                    float gasDensity = 0.2 + 0.8 * rings; 
                    
                    // Mezcla térmica (Blanco incandescente cerca, Naranja enfriándose lejos)
                    vec3 hotColor = vec3(1.2, 0.9, 0.6); 
                    vec3 coolColor = vec3(0.8, 0.2, 0.0); 
                    vec3 diskCol = mix(coolColor, hotColor, pow(gradient, 1.5)) * gasDensity;
                    
                    // Relativistic Beaming / Doppler Shift sobre la luz del propio disco
                    vec3 diskVel = normalize(vec3(-hit.z, 0.0, hit.x)); 
                    float doppler = dot(dir, diskVel) * gradient; 
                    
                    // Amplificación direccional de intensidad lumínica
                    float dopplerFactor = 1.0 + doppler * 3.0; 
                    diskCol *= dopplerFactor;
                    
                    // Alteración cromática (Blueshift / Redshift)
                    if(doppler > 0.0) {
                        diskCol.b += doppler * 0.8;
                        diskCol.r -= doppler * 0.3;
                    } else {
                        diskCol.r += abs(doppler) * 0.5;
                    }
                    
                    // Composición volumétrica (acumulación de luz cruzando el disco)
                    float opacity = 0.9 * gradient;
                    color += diskCol * (1.0 - alpha) * opacity;
                    alpha += opacity * (1.0 - alpha);
                }
            }
            
            // LA LENTE GRAVITACIONAL (Ecuación de Einstein-Schwarzschild)
            // Calculamos la aceleración transversal que curva el fotón hacia la masa
            float x_dot_v = dot(pos, dir);
            float L2 = r2 - x_dot_v * x_dot_v; // Conservación del momento angular L^2
            vec3 accel = -1.5 * rs * L2 / (r2 * r2 * r) * pos; // Ecuación de la geodésica
            
            // Curvamos el vector director y avanzamos la posición
            dir = normalize(dir + accel * h); 
            pos = nextPos;
        }

        // Si el rayo no interactuó con nada opaco, lo descartamos (transparencia hacia el fondo)
        if (alpha < 0.01) discard; 
        
        gl_FragColor = vec4(color, alpha);
    }
`;

// ============================================================================
// 4. COMPONENTE REACT PRINCIPAL (ORQUESTADOR)
// Gestiona el montaje de Three.js, el ciclo de vida del GPUComputationRenderer,
// los pases de post-procesamiento y el ciclo de animación a 60 FPS.
// ============================================================================

const GalaxyVisualizer = () => {
    const containerRef = useRef<HTMLDivElement>(null);
    const isPausedRef = useRef<boolean>(false);

    useEffect(() => {
        if (!containerRef.current) return;

        const WIDTH = 256; // Resolución de las texturas GPGPU (256x256 = 65,536 partículas)
        
        // Configuración Base de Escena y Cámara WebGL
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x000000); 
        
        // Frustum masivo (100,000) para permitir zoom inverso sin que el lienzo desaparezca
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100000);
        camera.position.set(0, 70, 200);

        const renderer = new THREE.WebGLRenderer({ antialias: false });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        // Reinhard Tone Mapping simula rangos dinámicos altos HDR (crítico para el brillo del plasma)
        renderer.toneMapping = THREE.ReinhardToneMapping; 
        containerRef.current.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.maxDistance = 20000; 

        // Pipeline de Post-Procesamiento (Bloom)
        const renderScene = new RenderPass(scene, camera);
        // Bloom Pass inyecta el "resplandor" característico de las películas espaciales
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.8, 0.6, 0.15);
        const composer = new EffectComposer(renderer);
        composer.addPass(renderScene);
        composer.addPass(bloomPass);

        // Malla del Agujero Negro (Lienzo para el Raymarcher)
        // Plano colosal para abarcar toda la vista independientemente de cuán lejos esté la cámara
        const gargantuaGeometry = new THREE.PlaneGeometry(100000, 100000);
        const gargantuaMaterial = new THREE.ShaderMaterial({
            vertexShader: gargantuaVertexShader,
            fragmentShader: gargantuaFragmentShader,
            transparent: true,
            depthWrite: false, // Permite que las partículas se mezclen detrás sin z-fighting
            blending: THREE.NormalBlending
        });
        const gargantuaMesh = new THREE.Mesh(gargantuaGeometry, gargantuaMaterial);
        scene.add(gargantuaMesh);
        gargantuaMesh.visible = false; // Oculto por defecto (modo galaxia al inicio)

        // Estado inicial de los Núcleos Gravitatorios
        let bh1 = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), mass: 1200 };
        let bh2 = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), mass: 1200 };
        
        // Inicialización de texturas GPGPU (Float32Arrays puros)
        const gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, renderer);
        const dtPosition = gpuCompute.createTexture();
        const dtVelocity = gpuCompute.createTexture();
        const posArray = dtPosition.image.data as Float32Array;
        const velArray = dtVelocity.image.data as Float32Array;

        // Función Generadora de Condiciones Iniciales Espaciales
        const generateInitialState = (type1: string, type2: string, mode: string) => {
            
            if (mode === 'blackhole') {
                // Semilla de distribución para Acreción (Un núcleo central masivo)
                gargantuaMesh.visible = true;
                bh1.pos.set(0, 0, 0); bh1.vel.set(0, 0, 0); bh1.mass = 6000;
                bh2.mass = 0; 

                for (let i = 0; i < posArray.length; i += 4) {
                    let r = Math.random() * 200 + 40; 
                    let theta = Math.random() * Math.PI * 2;
                    // Coordenadas cilíndricas/polares
                    let x = Math.cos(theta) * r;
                    let y = (Math.random() - 0.5) * (r * 0.1); 
                    let z = Math.sin(theta) * r;

                    // Cálculo de velocidad orbital inicial basada en mecánica Kepleriana: v = sqrt(GM/r)
                    const vMag = Math.sqrt((0.5 * bh1.mass) / r);
                    let vx = Math.sin(theta) * vMag;
                    let vy = (Math.random() - 0.5) * 0.5;
                    let vz = -Math.cos(theta) * vMag;

                    posArray[i] = x; posArray[i+1] = y; posArray[i+2] = z; posArray[i+3] = 1;
                    velArray[i] = vx; velArray[i+1] = vy; velArray[i+2] = vz; velArray[i+3] = 1;
                }
            } else {
                // Semilla de distribución para N-Body (Galaxias binarias)
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
                            // Distribución esférica probabilística para galaxias elípticas
                            let phi = Math.acos((Math.random() * 2) - 1);
                            x = r * Math.sin(phi) * Math.cos(theta);
                            y = r * Math.sin(phi) * Math.sin(theta);
                            z = r * Math.cos(phi);
                            const vMag = Math.sqrt((0.5 * centerObj.mass) / r);
                            vx = (Math.random() - 0.5) * vMag;
                            vy = (Math.random() - 0.5) * vMag;
                            vz = (Math.random() - 0.5) * vMag;
                        } else {
                            // Distribución de disco clásico para galaxias espirales
                            x = Math.cos(theta) * r;
                            y = (Math.random() - 0.5) * 2.5; 
                            z = Math.sin(theta) * r;
                            const vMag = Math.sqrt((0.5 * centerObj.mass) / r);
                            vx = Math.sin(theta) * vMag;
                            vy = (Math.random() - 0.5) * 1.5;
                            vz = -Math.cos(theta) * vMag;
                        }

                        // Asignación referenciada al centro galáctico dinámico
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

        // Configuración de los Materiales de Cómputo (GPGPU Variables)
        const posVar = gpuCompute.addVariable("texturePosition", computationShaderPosition, dtPosition);
        const velVar = gpuCompute.addVariable("textureVelocity", computationShaderVelocity, dtVelocity);
        
        // Dependencias cruzadas (Posición necesita Velocidad, Velocidad necesita Posición)
        gpuCompute.setVariableDependencies(posVar, [posVar, velVar]);
        gpuCompute.setVariableDependencies(velVar, [posVar, velVar]);
        
        // Inyección de Uniforms iniciales
        posVar.material.uniforms.dt = { value: 0.016 }; // Aprox 60fps delta
        velVar.material.uniforms.dt = { value: 0.016 };
        velVar.material.uniforms.gravity = { value: 0.15 };
        velVar.material.uniforms.softening = { value: 3.5 };
        velVar.material.uniforms.mass1 = { value: bh1.mass };
        velVar.material.uniforms.mass2 = { value: bh2.mass };
        velVar.material.uniforms.center1 = { value: bh1.pos };
        velVar.material.uniforms.center2 = { value: bh2.pos };
        velVar.material.uniforms.isBlackHoleMode = { value: 0.0 };
        
        gpuCompute.init();

        // Geometría del sistema de partículas (1 vértice por estrella)
        const geometry = new THREE.BufferGeometry();
        const uvs = new Float32Array(WIDTH * WIDTH * 2);
        for (let i = 0; i < WIDTH * WIDTH; i++) {
            // Mapeo UV matemático para extraer la coordenada exacta en la textura GPGPU
            uvs[i * 2] = (i % WIDTH) / WIDTH;
            uvs[i * 2 + 1] = Math.floor(i / WIDTH) / WIDTH;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WIDTH * WIDTH * 3), 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

        const material = new THREE.ShaderMaterial({
            uniforms: { 
                texturePosition: { value: null }, // Se inyectará en el render loop
                textureVelocity: { value: null }, // Se inyectará en el render loop
                cameraPos: { value: camera.position },
                useDoppler: { value: 1.0 },
                isBlackHoleMode: { value: 0.0 },
                center1: { value: bh1.pos },
                center2: { value: bh2.pos } 
            },
            vertexShader,
            fragmentShader,
            transparent: true,
            blending: THREE.AdditiveBlending, // Clave para las nebulosas: sumar luz
            depthWrite: false, // Previene el z-fighting entre miles de nubes de gas
            depthTest: true 
        });

        const points = new THREE.Points(geometry, material);
        scene.add(points);

        // Binding de UI y DOM Event Listeners
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
                // RESET LOGIC: Reevalúa estado del DOM y reinicia variables GPU
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

                // Forzar repintado inmediato en el RenderTarget de GPGPU
                gpuCompute.renderTexture(dtPosition, posVar.renderTargets[0]);
                gpuCompute.renderTexture(dtPosition, posVar.renderTargets[1]);
                gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[0]);
                gpuCompute.renderTexture(dtVelocity, velVar.renderTargets[1]);
            })
        ];

        // ============================================================================
        // BUCLE DE ANIMACIÓN PRINCIPAL (Render Loop)
        // Disparado sincronizadamente con la frecuencia de actualización del monitor.
        // ============================================================================
        const animate = () => {
            requestAnimationFrame(animate);
            controls.update();
            material.uniforms.cameraPos.value.copy(camera.position);

            // Crucial para la ilusión volumétrica: el lienzo del Raymarcher 
            // actúa como un billboard que siempre enfrenta al observador.
            if (gargantuaMesh.visible) {
                gargantuaMesh.lookAt(camera.position);
            }

            if (!isPausedRef.current) {
                if (currentMode === 'galaxy') {
                    // Macro-física CPU: Resolviendo la atracción gravitatoria mutua 
                    // entre los dos NÚCLEOS galácticos (las partículas se calculan en la GPU)
                    const dist = bh1.pos.clone().sub(bh2.pos);
                    const r2 = dist.lengthSq() + 5.0; 
                    const force = (currentG * bh1.mass * bh2.mass) / r2;
                    
                    const acc1 = dist.clone().normalize().multiplyScalar(-force / bh1.mass);
                    const acc2 = dist.clone().normalize().multiplyScalar(force / bh2.mass);
                    
                    bh1.vel.add(acc1.multiplyScalar(currentDt));
                    bh2.vel.add(acc2.multiplyScalar(currentDt));
                    bh1.pos.add(bh1.vel.clone().multiplyScalar(currentDt));
                    bh2.pos.add(bh2.vel.clone().multiplyScalar(currentDt));

                    // Sincronización CPU -> GPU de las posiciones dinámicas
                    velVar.material.uniforms.center1.value.copy(bh1.pos);
                    velVar.material.uniforms.center2.value.copy(bh2.pos);
                    material.uniforms.center1.value.copy(bh1.pos);
                    material.uniforms.center2.value.copy(bh2.pos);
                }

                // Ejecución del paso temporal físico GPGPU
                gpuCompute.compute();
                // Extracción de las nuevas texturas renderizadas e inyección en el Material Visual
                material.uniforms.texturePosition.value = gpuCompute.getCurrentRenderTarget(posVar).texture;
                material.uniforms.textureVelocity.value = gpuCompute.getCurrentRenderTarget(velVar).texture;
            }

            // Post-procesamiento y dibujo a la pantalla
            composer.render();
        };
        animate();

        // Manejo de Aspect Ratio para diseño responsivo
        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
            composer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        // Limpieza de memoria y eventos al desmontar componente
        return () => {
            window.removeEventListener('resize', handleResize);
            cleanups.forEach(c => c());
            renderer.dispose();
        };
    }, []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />;
};

export default GalaxyVisualizer;