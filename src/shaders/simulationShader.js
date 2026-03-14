export const simulationShader = `
  uniform float gravity;
  uniform float softening;
  uniform float dt;

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 pos = texture2D( texturePosition, uv );
    vec4 vel = texture2D( textureVelocity, uv );

    vec3 acceleration = vec3(0.0);

    // Aquí calculamos la interacción N-Body simplificada para el ejemplo
    // En una versión completa, iteraríamos por grupos de partículas
    // Aceleración = G * m * r / (r^2 + epsilon^2)^1.5
    
    // Suponiendo un punto de masa central (Agujero Negro Galáctico)
    vec3 dist = vec3(0.0) - pos.xyz; 
    float r2 = dot(dist, dist) + softening;
    acceleration += gravity * dist * pow(r2, -1.5);

    // Integración Leapfrog / Euler
    vel.xyz += acceleration * dt;
    pos.xyz += vel.xyz * dt;

    gl_FragColor = vec4( pos.xyz, 1.0 );
  }
`;