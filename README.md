# 🌌 Laboratorio Astrofísico N-Body & Renderizador Relativista

![WebGL](https://img.shields.io/badge/WebGL-2.0-blue.svg)
![Three.js](https://img.shields.io/badge/Three.js-r128+-black.svg)
![GPGPU](https://img.shields.io/badge/GPGPU-Compute-green.svg)
![Astro](https://img.shields.io/badge/Astro-Build-orange.svg)

Un simulador astrofísico acelerado por hardware (GPU) que modela colisiones galácticas mediante el problema de los N-cuerpos y visualiza la curvatura del espacio-tiempo alrededor de un agujero negro de Schwarzschild mediante trazado de rayos relativista (Raymarching).

Este proyecto no es una simple animación pre-renderizada; es un motor de física en tiempo real que resuelve sistemas de ecuaciones diferenciales para miles de partículas y fotones simultáneamente a 60 FPS.

## 🚀 Arquitectura Técnica

El simulador utiliza **GPGPU (General-Purpose computing on Graphics Processing Units)** mediante texturas de datos flotantes (`Float32Array`) y FBOs (Framebuffer Objects). 

* **Motor Lógico:** React.js / Astro para la gestión del estado y la UI.
* **Motor Gráfico:** Three.js para el pipeline de renderizado y el Post-Procesamiento (Unreal Bloom Pass, Reinhard Tone Mapping).
* **Motor Físico:** Shaders GLSL personalizados inyectados directamente en la tarjeta gráfica para el cálculo paralelo masivo.

---

## 🧮 Física Implementada

### 1. Colisión Galáctica (Simulación N-Body)
La simulación de las galaxias se basa en la integración numérica de la Ley de Gravitación Universal de Newton, modificada para evitar singularidades matemáticas.

* **Integración Temporal:** Se utiliza un método de Euler semi-implícito para la actualización del espacio fase (posición y velocidad).
* **Suavizado Gravitacional (Plummer Softening):** Para evitar fuerzas infinitas y aceleraciones anómalas (el "efecto honda") cuando la distancia entre masas tiende a cero $r \to 0$, se introduce un parámetro de suavizado $\epsilon$:
    $$\vec{a}_i = G \sum_{j \neq i} \frac{m_j (\vec{r}_j - \vec{r}_i)}{(|\vec{r}_j - \vec{r}_i|^2 + \epsilon^2)^{3/2}}$$
* **Efecto Doppler (Redshift/Blueshift):** Se calcula el producto punto entre el vector velocidad de cada estrella $\vec{v}$ y el vector normalizado de la línea de visión del observador $\vec{c}$. La matriz de color se desplaza hacia el azul ($\Delta \lambda < 0$) o hacia el rojo ($\Delta \lambda > 0$) basándose en este acercamiento o alejamiento relativo.

### 2. Agujero Negro (Métrica de Schwarzschild)
En lugar de mallas 3D tradicionales, el agujero negro se renderiza mediante un **Raymarcher Volumétrico** que resuelve la trayectoria de la luz en un espacio-tiempo curvo.

* **Lente Gravitacional (Desviación de la Luz):** La trayectoria de cada fotón (rayo visual) se calcula integrando la ecuación de las geodésicas en la métrica de Schwarzschild. La aceleración del fotón debido a la curvatura transversal del espacio-tiempo está dada por la conservación del momento angular $L$:
    $$\frac{d^2\vec{r}}{dt^2} = -1.5 R_s \frac{L^2}{r^5} \vec{r}$$
    Donde $R_s$ es el Radio de Schwarzschild.
* **Anatomía del Agujero Negro Modelada:**
    * **Horizonte de Sucesos ($r < R_s$):** Sumidero absoluto de información. Los rayos que cruzan este umbral detienen su integración (`discard`).
    * **Esfera de Fotones ($r \approx 1.5 R_s$):** Órbitas de luz inestables, modeladas por la alta densidad de rayos curvados críticamente.
    * **ISCO (Órbita Circular Estable Más Interna, $r = 3 R_s$):** Punto crítico computado dinámicamente donde el disco de acreción pierde estabilidad y comienza su caída libre, manifestado como una caída brusca en el gradiente de luminosidad del gas.
* **Termodinámica y Efectos Relativistas del Disco:** El disco de acreción incorpora *Relativistic Beaming* (Doppler Boosting). El plasma que gira acercándose al observador incrementa dramáticamente su frecuencia visible (blanco/azul incandescente) y amplitud geométrica, mientras el gas que se aleja experimenta un corrimiento al rojo térmico (naranja/rojo oscuro).

---

## 🛠️ Características Principales

* **Selector de Morfología:** Generación procedural de distribuciones de materia para Galaxias Espirales (discos con dispersión gaussiana) y Elípticas (enjambres esféricos caóticos).
* **Gargantua Accretion Disk:** Renderizado volumétrico del disco de gas cortado por el horizonte de sucesos, con estriaciones de densidad basadas en funciones armónicas.
* **Escalabilidad Dinámica:** Soporta zoom y paneo desde el núcleo de la singularidad (0 unidades) hasta más de 100,000 unidades en el vacío espacial, ajustando dinámicamente el *step size* del raymarching (Adaptive Ray Stepping).
* **Absorción de Materia Dinámica:** Las partículas del sistema N-Body que cruzan el $R_s$ del raymarcher sufren un colapso cinético y son retiradas del renderizado para simular la acreción de masa.

## 💻 Instalación y Uso Local

Para correr este laboratorio en un entorno local de desarrollo:

1. Clona el repositorio:
   \`\`\`bash
   git clone https://github.com/AngelOlivares842/galaxy
   \`\`\`
2. Instala las dependencias (se requiere Node.js):
   \`\`\`bash
   npm install
   \`\`\`
3. Inicia el servidor de desarrollo en la red local:
   \`\`\`bash
   npm run dev
   \`\`\`
4. Abre tu navegador y navega a `http://localhost:4321`. Se requiere una tarjeta gráfica dedicada moderna (Nvidia/AMD) o una GPU integrada reciente de Apple (M1/M2/M3) para mantener 60 FPS estables.

## 🎮 Controles de Simulación

* **Gravedad Base (G):** Altera la Constante de Gravitación Universal para el sistema. Valores en `0.0` desactivan la atracción, provocando la desintegración inercial de las galaxias.
* **Velocidad Temporal (dt):** Controla el Delta Time de la integración. Útil para observar interacciones rápidas o congelar colisiones microscópicas.
* **Modo de Simulación:** Alterna en tiempo real entre el procesamiento puro N-Body y el rendering del tensor métrico (Agujero Negro).

---
*Desarrollado con fines de investigación gráfica y pasión por la astrofísica computacional.*
