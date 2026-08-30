using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

// Captura continua de una ventana puntual vía Windows.Graphics.Capture y
// vuelca frames crudos BGRA por stdout, a un fps fijo (paced por timer, no
// por la tasa real de pintado de la ventana). Pensado para que el proceso
// padre (main.js) le mande ese stdout directo a ffmpeg como "-f rawvideo".
//
// Protocolo con el proceso padre:
//   - Primera línea por STDERR: "SIZE <ancho> <alto>" en cuanto se resuelve
//     la ventana (o "NOTFOUND" si no se encontró, y termina con código 2).
//   - STDOUT: solo bytes crudos de frames (nada de texto mezclado).
//   - Para cortar prolijamente: escribirle cualquier línea a STDIN (mismo
//     patrón que ya usa la app con ffmpeg mandándole "q").

if (args.Length < 2)
{
    Console.Error.WriteLine("Uso: wgc-capture.exe <hwnd_numerico | substring_del_titulo> <fps> [duracion_segundos_para_pruebas]");
    return 1;
}

string windowIdentifier = args[0];
int fps = int.Parse(args[1]);
double? testDurationSeconds = args.Length > 2 ? double.Parse(args[2]) : null;

// Electron expone el HWND real en el id de la fuente de ventana
// ("window:<hwnd>:0") — usarlo directo es exacto, a diferencia de buscar
// por texto de título, que puede fallar o elegir la ventana equivocada si
// hay dos con nombres parecidos (ej. dos ventanas de Chrome). Se mantiene
// la búsqueda por substring como respaldo (y para probar el helper a mano
// desde la terminal, donde es más cómodo pasar un texto que un número).
IntPtr hwnd = long.TryParse(windowIdentifier, out long hwndValue) && hwndValue > 0
    ? new IntPtr(hwndValue)
    : NativeMethods.FindWindowByTitleSubstring(windowIdentifier);
if (hwnd == IntPtr.Zero || !NativeMethods.IsWindow(hwnd))
{
    Console.Error.WriteLine("NOTFOUND");
    return 2;
}

GraphicsCaptureItem item = CaptureInterop.CreateItemForWindow(hwnd);
int width = item.Size.Width;
int height = item.Size.Height;
Console.Error.WriteLine($"SIZE {width} {height}");
Console.Error.Flush();

using ID3D11Device d3dDevice = D3D11.D3D11CreateDevice(DriverType.Hardware, DeviceCreationFlags.BgraSupport);
using ID3D11DeviceContext d3dContext = d3dDevice.ImmediateContext;
IDirect3DDevice winrtDevice = CaptureInterop.CreateDirect3DDeviceFromD3D11Device(d3dDevice);

// Con solo 2 buffers (el mínimo/default de muchos ejemplos), si nuestra
// propia copia a CPU se atrasa aunque sea un poco, WGC se queda sin buffer
// libre para el próximo frame y tiene que esperar — eso retrasaría la
// ENTREGA real del siguiente frame por culpa nuestra, no del juego. Más
// buffers le dan margen a WGC para seguir produciendo aunque nosotros
// vayamos un poco atrás consumiendo.
// Medido contra Genshin real con series de pruebas alternadas (para
// promediar la variación enorme de un momento a otro del juego): 16
// buffers le ganó a 10 las 3 veces seguidas (promedio 22.5% -> 11.6% de
// frames repetidos). Subir más allá de 16 (a 24) ya no dio una mejora
// consistente — rendimientos decrecientes. El costo de memoria de buffers
// de más es insignificante (unos pocos MB), así que 16 es el punto justo.
int bufferCount = int.TryParse(Environment.GetEnvironmentVariable("WGC_BUFFERS"), out var bufOverride) ? bufOverride : 16;
using Direct3D11CaptureFramePool framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
    winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, bufferCount, item.Size);
using GraphicsCaptureSession session = framePool.CreateCaptureSession(item);

// Instrumentación de diagnóstico (DIAG=1): un reloj compartido entre el
// callback de frames y el loop de salida para poder medir, con precisión
// real, cuándo llega cada frame de verdad y cuán "vieja" es la que se
// termina mandando en cada tick de salida.
bool diag = Environment.GetEnvironmentVariable("WGC_DIAG") == "1";
var sw = System.Diagnostics.Stopwatch.StartNew();

var frameLock = new object();
byte[]? latestFrameBytes = null;
long latestFrameGeneration = 0;
long latestFrameStoredAtMs = 0;
long lastArrivalMs = -1;
ID3D11Texture2D? staging = null;

bool sizeChanged = false;
framePool.FrameArrived += (sender, _) =>
{
    using Direct3D11CaptureFrame frame = sender.TryGetNextFrame();
    try
    {
        if (diag)
        {
            long arrivalMs = sw.ElapsedMilliseconds;
            long gapMs = lastArrivalMs < 0 ? -1 : arrivalMs - lastArrivalMs;
            lastArrivalMs = arrivalMs;
            Console.Error.WriteLine($"DIAG ARRIVE t={arrivalMs} gapDesdeAnterior={gapMs}");
        }
        // Chequear el tamaño ANTES de tocar frame.Surface/la textura: si el
        // juego ya cambió de resolución interna, el swapchain de atrás puede
        // estar en un estado inválido/en transición, y llegar a agarrar la
        // textura igual (aunque después comparemos tamaños) es lo que
        // terminaba crasheando el proceso entero más abajo en la cadena de
        // interop nativa (un crash así no se puede atajar con try/catch).
        if (frame.ContentSize.Width != width || frame.ContentSize.Height != height)
        {
            throw new CaptureInterop.FrameSizeChangedException(
                $"El tamaño real cambió de {width}x{height} a {frame.ContentSize.Width}x{frame.ContentSize.Height}.");
        }

        // CreateFreeThreaded puede disparar este callback desde threads
        // distintos (de hecho parece ser justo lo que pasaba: los primeros
        // 1-2 frames salían bien y después crasheaba). ID3D11DeviceContext
        // (el ImmediateContext que se usa acá para Map/CopyResource/Unmap)
        // NO es thread-safe: si dos llamados a este handler se solapan,
        // corrompen el contexto. Serializar todo el Map/Copy/Unmap con un
        // lock es la forma correcta de arreglarlo (no solo la asignación
        // final del buffer, como estaba antes).
        byte[] bytes;
        lock (frameLock)
        {
            bytes = CaptureInterop.ReadFrameBytes(frame, d3dDevice, d3dContext, ref staging, width, height);
            latestFrameBytes = bytes;
            latestFrameGeneration++;
            latestFrameStoredAtMs = sw.ElapsedMilliseconds;
            if (diag)
            {
                long copyMs = latestFrameStoredAtMs - lastArrivalMs;
                Console.Error.WriteLine($"DIAG STORED gen={latestFrameGeneration} t={latestFrameStoredAtMs} copyMs={copyMs}");
            }
        }
    }
    catch (CaptureInterop.FrameSizeChangedException ex)
    {
        // Juegos con resolución dinámica (Genshin, muchos otros) pueden
        // cambiar el tamaño real del framebuffer a mitad de la grabación.
        // Seguir asumiendo el tamaño viejo corrompía memoria (leía más allá
        // del buffer real) y terminaba crasheando el proceso entero. Frenar
        // acá en limpio es mucho mejor: el proceso padre ve que este helper
        // terminó y cae al método viejo (o avisa el error), en vez de un
        // crash nativo sin ninguna explicación.
        Console.Error.WriteLine($"RESIZED {ex.Message}");
        sizeChanged = true;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"FRAMEERR {ex.Message}");
    }
};

session.StartCapture();

bool running = true;
var stdinThread = new Thread(() =>
{
    Console.In.ReadLine();
    running = false;
});
stdinThread.IsBackground = true;
stdinThread.Start();

using Stream stdout = Console.OpenStandardOutput();
int frameIntervalMs = Math.Max(1, 1000 / fps);
long nextTick = 0;

// Medido con diagnóstico real contra Genshin: WGC no entrega frames nuevos
// a un ritmo perfectamente parejo — se vieron huecos reales de hasta
// ~118ms entre un frame y el siguiente (contra los 33ms que se esperarían
// a 30fps), aunque la gran mayoría de los huecos entran dentro de 100ms.
// Sin este margen, cada uno de esos huecos obligaba a repetir el último
// frame antes de tiempo (~13% de los frames de salida terminaban
// repetidos, medido). Como esto es una GRABACIÓN, no una transmisión en
// vivo, no importa perder un poquito de latencia: se atrasa la decisión
// de qué frame mandar por este margen, dándole a WGC tiempo de sobra para
// entregar el frame real correspondiente antes de vernos obligados a
// repetir el anterior.
long OutputLagMs = long.TryParse(Environment.GetEnvironmentVariable("WGC_LAG_MS"), out var lagOverride) ? lagOverride : 60;
long lastWrittenGeneration = -1;

bool stopped = false;
while (running && !sizeChanged && !stopped)
{
    long now = sw.ElapsedMilliseconds;
    if (testDurationSeconds.HasValue && now >= testDurationSeconds.Value * 1000) break;

    // OJO: esto tiene que ser "while", no "if". ffmpeg no recibe ninguna
    // marca de tiempo real por este pipe (-f rawvideo): asume que cada
    // frame que le llega dura exactamente 1/fps. Si acá nos atrasamos
    // (el juego + la copia de cada frame + el encoder en vivo compitiendo
    // por CPU) y nos limitamos a mandar UN frame y reacomodar nextTick
    // hacia el "ahora", los intervalos que nos saltamos se pierden para
    // siempre: ffmpeg termina con menos frames de los que corresponden al
    // tiempo real transcurrido, y arma un video más corto que la grabación
    // real (se ve "acelerado"). Repitiendo el último frame disponible una
    // vez por cada intervalo atrasado, el conteo total de frames siempre
    // coincide con el tiempo real, aunque a veces haya algún frame
    // duplicado (mejor un poquito de stutter que un video mal cronometrado).
    while (nextTick + OutputLagMs <= now)
    {
        if (!WriteTick(nextTick)) { stopped = true; break; }
        nextTick += frameIntervalMs;
    }
    Thread.Sleep(1);
}

// Al cortar quedan pendientes los últimos ~OutputLagMs de video que el
// margen de arriba todavía no había liberado — sin este drenado final, cada
// grabación perdería sistemáticamente ese pedacito del final (el mismo tipo
// de problema de duración que ya se arregló antes, sería tonto reintroducirlo
// por el margen nuevo). Acá ya no hace falta esperar el margen: se manda todo
// lo que quede hasta el "ahora" real.
if (!stopped)
{
    long finalNow = sw.ElapsedMilliseconds;
    while (nextTick <= finalNow)
    {
        if (!WriteTick(nextTick)) break;
        nextTick += frameIntervalMs;
    }
}

session.Dispose();
framePool.Dispose();
Console.Error.WriteLine("DONE");
return 0;

bool WriteTick(long tickTime)
{
    byte[]? frame;
    long gen = -1, storedAt = 0;
    lock (frameLock) { frame = latestFrameBytes; gen = latestFrameGeneration; storedAt = latestFrameStoredAtMs; }
    if (frame == null) return true;
    if (diag)
    {
        bool repeat = gen == lastWrittenGeneration;
        long staleMs = tickTime - storedAt;
        Console.Error.WriteLine($"DIAG TICK t={tickTime} gen={gen} repeat={repeat} staleMs={staleMs}");
    }
    lastWrittenGeneration = gen;
    try
    {
        stdout.Write(frame, 0, frame.Length);
        stdout.Flush();
        return true;
    }
    catch
    {
        return false; // el pipe se cerró del otro lado (ffmpeg terminó)
    }
}

internal static class NativeMethods
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    public static IntPtr FindWindowByTitleSubstring(string substring)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, _) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString().Contains(substring, StringComparison.OrdinalIgnoreCase))
            {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}

[ComImport]
[Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IGraphicsCaptureItemInterop
{
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
}

[ComImport]
[Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDirect3DDxgiInterfaceAccess
{
    IntPtr GetInterface([In] ref Guid iid);
}

internal static class CaptureInterop
{
    private static readonly Guid GraphicsCaptureItemGuid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private static readonly Guid ID3D11Texture2DGuid = new("6F15AAF2-D208-4E89-9AB4-489535D34F9C");

    [DllImport("combase.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void RoGetActivationFactory(IntPtr activatableClassId, [In] ref Guid iid, out IntPtr factory);

    [DllImport("combase.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = false)]
    private static extern void WindowsCreateString(string sourceString, int length, out IntPtr hstring);

    [DllImport("combase.dll", ExactSpelling = true)]
    private static extern int WindowsDeleteString(IntPtr hstring);

    [DllImport("d3d11.dll", EntryPoint = "CreateDirect3D11DeviceFromDXGIDevice", PreserveSig = false)]
    private static extern IntPtr CreateDirect3D11DeviceFromDXGIDeviceNative(IntPtr dxgiDevice);

    public static GraphicsCaptureItem CreateItemForWindow(IntPtr hwnd)
    {
        const string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        WindowsCreateString(className, className.Length, out IntPtr hstr);
        try
        {
            Guid interopGuid = typeof(IGraphicsCaptureItemInterop).GUID;
            RoGetActivationFactory(hstr, ref interopGuid, out IntPtr factoryPtr);
            var factory = (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factoryPtr);
            Marshal.Release(factoryPtr);

            Guid itemGuid = GraphicsCaptureItemGuid;
            IntPtr itemPtr = factory.CreateForWindow(hwnd, ref itemGuid);
            var item = WinRT.MarshalInterface<GraphicsCaptureItem>.FromAbi(itemPtr);
            Marshal.Release(itemPtr);
            return item;
        }
        finally
        {
            WindowsDeleteString(hstr);
        }
    }

    public static IDirect3DDevice CreateDirect3DDeviceFromD3D11Device(ID3D11Device d3dDevice)
    {
        using IDXGIDevice dxgiDevice = d3dDevice.QueryInterface<IDXGIDevice>();
        IntPtr ptr = CreateDirect3D11DeviceFromDXGIDeviceNative(dxgiDevice.NativePointer);
        var device = WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(ptr);
        Marshal.Release(ptr);
        return device;
    }

    public sealed class FrameSizeChangedException : Exception
    {
        public FrameSizeChangedException(string message) : base(message) { }
    }

    public static byte[] ReadFrameBytes(Direct3D11CaptureFrame frame, ID3D11Device device, ID3D11DeviceContext context, ref ID3D11Texture2D? staging, int expectedWidth, int expectedHeight)
    {
        var winrtObj = (WinRT.IWinRTObject)frame.Surface;
        IntPtr surfacePtr = winrtObj.NativeObject.ThisPtr;

        Guid accessIid = typeof(IDirect3DDxgiInterfaceAccess).GUID;
        Marshal.ThrowExceptionForHR(Marshal.QueryInterface(surfacePtr, ref accessIid, out IntPtr accessPtr));
        var access = (IDirect3DDxgiInterfaceAccess)Marshal.GetTypedObjectForIUnknown(accessPtr, typeof(IDirect3DDxgiInterfaceAccess));
        Marshal.Release(accessPtr);

        Guid texIid = ID3D11Texture2DGuid;
        IntPtr texPtr = access.GetInterface(ref texIid);
        // OJO: a diferencia de Marshal.GetTypedObjectForIUnknown (que sí
        // suma su propia referencia al crear el RCW, por eso ahí arriba es
        // correcto liberar accessPtr después), el constructor de Vortice
        // ID3D11Texture2D(IntPtr) ADOPTA el puntero tal cual viene (no suma
        // referencia propia): liberar texPtr acá además sería un doble
        // release sobre la MISMA referencia que ya nos dio GetInterface(),
        // lo que corrompía el objeto y explica el crash después de un rato
        // de uso normal (el "using" de abajo ya se encarga de esa única
        // referencia al liberar sourceTexture).
        using var sourceTexture = new ID3D11Texture2D(texPtr);

        var actualDesc = sourceTexture.Description;

        // Varios juegos (Genshin incluido, medido en esta misma máquina)
        // cambian la resolución interna del framebuffer a mitad de partida
        // (resolución dinámica). Ya le dijimos al proceso padre un tamaño
        // fijo por stderr al arrancar (que ffmpeg usa como "-s" fijo para
        // todo el rawvideo); si el tamaño real cambia, la única opción
        // segura es cortar acá en vez de asumir el tamaño viejo y leer más
        // allá del buffer real (eso es lo que corrompía memoria y crasheaba
        // el proceso antes de este cambio).
        if (actualDesc.Width != (uint)expectedWidth || actualDesc.Height != (uint)expectedHeight)
        {
            throw new FrameSizeChangedException(
                $"El tamaño real cambió de {expectedWidth}x{expectedHeight} a {actualDesc.Width}x{actualDesc.Height}.");
        }

        if (staging == null)
        {
            var desc = actualDesc;
            desc.Usage = ResourceUsage.Staging;
            desc.BindFlags = BindFlags.None;
            desc.CPUAccessFlags = CpuAccessFlags.Read;
            desc.MiscFlags = ResourceOptionFlags.None;
            staging = device.CreateTexture2D(desc);
        }
        context.CopyResource(staging, sourceTexture);

        var mapped = context.Map(staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
        try
        {
            int rowPitch = (int)mapped.RowPitch;
            int rowBytes = expectedWidth * 4;
            if (rowPitch < rowBytes)
            {
                // No debería pasar nunca si ya confirmamos que el tamaño es
                // el esperado arriba, pero por las dudas: nunca leer más de
                // lo que el row pitch real permite.
                throw new FrameSizeChangedException($"Row pitch inesperado: {rowPitch} < {rowBytes}.");
            }
            byte[] result = new byte[rowBytes * expectedHeight];
            if (rowPitch == rowBytes)
            {
                // Sin padding entre filas: todo el bloque es contiguo, se
                // puede copiar de una sola vez. Mucho más rápido que un
                // Marshal.Copy por cada fila (cada llamada cruza a código
                // nativo; para 1080 filas eso suma).
                Marshal.Copy(mapped.DataPointer, result, 0, rowBytes * expectedHeight);
            }
            else
            {
                for (int y = 0; y < expectedHeight; y++)
                {
                    IntPtr srcRow = IntPtr.Add(mapped.DataPointer, y * rowPitch);
                    Marshal.Copy(srcRow, result, y * rowBytes, rowBytes);
                }
            }
            return result;
        }
        finally
        {
            context.Unmap(staging, 0);
        }
    }
}
