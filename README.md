# Lowey Screen Recorder

Grabador de pantalla y aplicaciones para escritorio (Windows, macOS, Linux) pensado para lograr **la máxima calidad posible con el menor peso de archivo**, a diferencia de grabadores como Action! que graban directo a un bitrate fijo alto y generan archivos enormes.

La app tiene un **switch en el encabezado** para cambiar entre dos modos, cada uno con su propio nombre:

- **Lowey Screen Recorder**: al cortar la grabación, se optimiza automáticamente (como se explica abajo).
- **Abi's Quick Recorder**: grabar no espera nunca a que termine de optimizarse lo anterior — el botón queda libre al instante y la captura va a "Grabaciones sin optimizar", para comprimirla cuando quieras (una por una o varias juntas).

El resto de las funciones (fuentes de captura, región, modos de captura, resolución de salida, atajo de teclado, etc.) son las mismas en los dos modos.

## Cómo logra "máxima calidad, poco peso"

La mayoría de los grabadores escriben el video final en tiempo real con un bitrate fijo: para no perder calidad usan un bitrate muy alto durante toda la grabación, y eso es lo que infla el tamaño del archivo.

Este grabador separa el proceso en dos etapas:

1. **Captura en tiempo real**: se graba la pantalla/aplicación elegida a un bitrate alto (VP9/WebM) solo para garantizar que no se pierdan cuadros ni se degrade la imagen mientras grabás. Este archivo intermedio es temporal y pesado.
2. **Recompresión por calidad constante (CRF)**: al detener la grabación, se vuelve a codificar automáticamente con `ffmpeg` usando H.265 o H.264 en modo **CRF** (calidad constante), que asigna más bits solo donde hay más detalle/movimiento y muchos menos donde la imagen es estática (texto, ventanas, IDEs, etc.). El resultado es un archivo final con calidad visual equivalente (o mejor) y un tamaño mucho menor. El archivo intermedio se borra automáticamente al terminar.

Al final de cada grabación la app muestra el tamaño de la captura intermedia vs. el archivo final y el porcentaje de ahorro.

## Funciones

- Grabar **toda la pantalla**, **una aplicación/ventana específica**, o **una región elegida a mano** (arrastrando un rectángulo sobre una vista previa).
- 4 perfiles de calidad final: **Rápida (GPU)** (prueba HEVC y H.264 por NVENC/Quick Sync/AMF, y si no hay GPU compatible cae a CPU sola), **Equilibrada** (H.264 CRF 23, máxima compatibilidad), **Ligera** (H.264 CRF 28) y **Alta calidad HEVC (audio intacto)** (H.265 CRF 22 en una sola pasada, audio copiado tal cual sin recodificar).
- **Resolución de salida** independiente de la resolución de captura (Original / 1080p / 720p / 480p) para achicar el peso sin tocar el codec.
- **Modo de captura**: "Modo Visual Novel" (toda la potencia, para juegos/apps livianas) o "Modo juego exigente" (baja la exigencia de la captura EN VIVO para no competirle recursos a un juego pesado corriendo al mismo tiempo; no afecta la calidad del archivo final).
- 30 o 60 fps.
- Audio del sistema y/o micrófono (se mezclan automáticamente si se activan ambos).
- Elegir carpeta de destino y **carpeta temporal** por separado (útil si el disco donde Windows guarda los temporales por defecto, normalmente C:, no tiene espacio para grabaciones largas). La elección de carpeta temporal se guarda entre sesiones.
- Progreso de la optimización final y comparación de tamaños.
- Sonido y notificación nativa de Windows al terminar de optimizar el video.
- Indicador flotante mini con el tiempo de grabación (no aparece en la propia grabación) para cuando grabás sin tener la ventana abierta.
- Atajo de teclado global **"F9"** para iniciar/detener la grabación sin tener que abrir la ventana de la app (así no te tapa lo que estás grabando).
- En modo **Abi's Quick Recorder**: sección "Grabaciones sin optimizar" para elegir cuándo comprimir cada captura, en vez de hacerlo automático al cortar.

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior.

No hace falta instalar `ffmpeg` por separado: se incluye automáticamente vía `ffmpeg-static`.

## Instalar (sin tocar código)

En la sección [Releases](https://github.com/Xyzccords/Lowey-Screen-Recorder/releases) del repositorio se publican automáticamente los instaladores listos para usar:

- **Windows**: `Lowey Screen Recorder Setup X.X.X.exe`. Es un instalador NSIS normal: permite elegir la carpeta de instalación, crea accesos directos y **queda registrado en "Agregar o quitar programas" con su propio desinstalador**.
- **macOS**: `Lowey Screen Recorder-X.X.X.dmg`.
- **Linux**: `Lowey Screen Recorder-X.X.X.AppImage` (no requiere instalación, se ejecuta directo).

Los instaladores se generan y publican solos con GitHub Actions cada vez que se crea un tag `vX.X.X` (ver `.github/workflows/release.yml`).

## Desarrollo (correr desde el código fuente)

```bash
npm install
npm start
```

## Generar instalador/ejecutable localmente

```bash
npm run dist
```

Genera el instalador para el sistema operativo actual (NSIS en Windows, DMG en macOS, AppImage en Linux) usando `electron-builder`. Para publicarlo directamente en un Release de GitHub: `GH_TOKEN=<token> npx electron-builder --publish always`.

## Notas sobre el audio del sistema

Capturar el audio del propio sistema operativo ("loopback") depende del sistema operativo:

- **Windows**: funciona de forma nativa al elegir una pantalla completa.
- **macOS**: Chromium/Electron no tiene acceso nativo al audio del sistema; se necesita un driver de audio virtual (por ejemplo BlackHole) para poder capturarlo.
- **Linux**: depende del servidor de audio (PulseAudio/PipeWire) y puede requerir configuración adicional.

Si el audio del sistema no está disponible, la app simplemente graba sin él (o solo con el micrófono, si está activado).

## Estructura del proyecto

```
main.js          Proceso principal de Electron: fuentes de captura, ventana flotante, escritura del archivo temporal y recompresión con ffmpeg.
preload.js       Puente seguro (contextBridge) entre el proceso principal y la interfaz.
src/index.html   Interfaz.
src/renderer.js  Lógica de captura (getUserMedia/MediaRecorder), recorte de región y control de la grabación.
src/styles.css   Estilos.
src/floating.html / floating.js  Ventanita flotante con el tiempo de grabación.
```
