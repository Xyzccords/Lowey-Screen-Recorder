# Lowey Quick Recorder

Edición separada de [Lowey Screen Recorder](../README.md), pensada para otro caso de uso: grabar seguido, sin cortes ni esperas.

## En qué se diferencia de Lowey Screen Recorder

En la app normal, al cortar una grabación se optimiza automáticamente y hay que esperar a que termine para poder grabar de nuevo. Acá no: apenas cortás, el botón de grabar queda libre al instante y la captura queda esperando en **"Grabaciones sin optimizar"**. Comprimís cuando quieras — una por una, varias juntas, o nunca si no hace falta — sin que eso te frene para seguir grabando.

También suma un perfil de calidad extra, **"Tamaño objetivo (~1GB, audio intacto)"**: calcula (con dos pasadas de `ffmpeg`) el bitrate justo para que el video entre en ~1GB con la mejor calidad posible para ese tamaño, sin recodificar el audio.

Todo lo demás (fuentes de captura, región, modos de captura, resolución de salida, atajo de teclado, indicador flotante, carpeta temporal configurable) funciona igual que en la app normal. El atajo de teclado por defecto es **F10** en vez de F9, para poder tener las dos apps instaladas sin que se pisen los atajos.

## Instalar, desarrollar, compilar

Igual que la app principal, pero parado en esta carpeta:

```bash
cd quick-recorder
npm install
npm start        # desarrollo
npm run dist      # generar instalador local
```

El instalador de esta edición se publica junto con el de la app principal en la misma sección [Releases](https://github.com/Xyzccords/Lowey-Screen-Recorder/releases) del repositorio, como un `.exe`/`.dmg`/`.AppImage` aparte (`Lowey Quick Recorder Setup X.X.X...`), con su propio desinstalador independiente.
