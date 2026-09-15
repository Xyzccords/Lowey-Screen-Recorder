// ⚠️ NUNCA COMPILADO NI PROBADO EN WINDOWS REAL. Esto usa la API de "Process
// Loopback" de Windows (10 versión 2004 en adelante, mmdevapi.dll +
// ActivateAudioInterfaceAsync con AUDIOCLIENT_ACTIVATION_PARAMS), armada a
// mano a partir de la documentación pública de Microsoft y la muestra
// oficial en C++ "ApplicationLoopback" — no de una librería ya probada
// (NAudio no tiene esto estable en su release actual). Es la parte más
// arriesgada de todo Abiction!: puede que falte algún detalle de marshaling
// (el paso más delicado es empaquetar AUDIOCLIENT_ACTIVATION_PARAMS dentro
// de un PROPVARIANT) que solo se puede detectar compilando y probando en
// Windows de verdad. Si falla, revisar primero ese marshaling.
//
// Uso: wgc-audio-capture.exe <hwnd> [--tree|--no-tree]
//   - <hwnd>: handle de la ventana a grabar (mismo identificador que usa
//     wgc-capture.exe para video). Se resuelve el proceso dueño de esa
//     ventana con GetWindowThreadProcessId y se activa el loopback de audio
//     para ESE proceso puntual, no todo el sistema.
//   - --tree (default): incluye también los procesos hijos del proceso
//     dueño de la ventana (INCLUDE_TARGET_PROCESS_TREE). Hace falta para
//     apps tipo Electron (Discord, Zoom en algunos casos) donde el audio en
//     realidad lo reproduce un proceso "renderer" hijo, no el principal.
//   - --no-tree: solo el proceso exacto (EXCLUDE_TARGET_PROCESS_TREE).
//
// Protocolo (mismo estilo que wgc-capture.exe):
//   - Por stderr: "FORMAT <sampleRate> <channels>" apenas se conoce el
//     formato real que entrega WASAPI, o "NOTFOUND" si no se pudo resolver
//     la ventana/proceso o activar el loopback.
//   - Por stdout: PCM float32 crudo intercalado (interleaved), sin ningún
//     encabezado — para pasarlo directo a ffmpeg con
//     "-f f32le -ar <sampleRate> -ac <channels> -i pipe:0".
//   - Cualquier línea por stdin le pide que cierre prolijo y termine.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length < 1 || !uint.TryParse(args[0], out uint hwndValue))
        {
            Console.Error.WriteLine("NOTFOUND");
            return 1;
        }

        bool includeTree = args.Length < 2 || args[1] != "--no-tree";
        IntPtr hwnd = new IntPtr((long)hwndValue);

        NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
        if (pid == 0)
        {
            Console.Error.WriteLine("NOTFOUND");
            return 1;
        }

        try
        {
            RunCapture(pid, includeTree);
            return 0;
        }
        catch (Exception ex)
        {
            // Cualquier falla de COM/marshaling cae acá: se reporta NOTFOUND
            // para que main.js caiga al método viejo (audio de todo el
            // sistema) en vez de dejar la grabación sin audio en silencio.
            Console.Error.WriteLine("NOTFOUND");
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void RunCapture(uint targetPid, bool includeTree)
    {
        var activationParams = new NativeMethods.AUDIOCLIENT_ACTIVATION_PARAMS
        {
            ActivationType = NativeMethods.AUDIOCLIENT_ACTIVATION_TYPE.AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            ProcessLoopbackParams = new NativeMethods.AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
            {
                TargetProcessId = targetPid,
                ProcessLoopbackMode = includeTree
                    ? NativeMethods.PROCESS_LOOPBACK_MODE.PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                    : NativeMethods.PROCESS_LOOPBACK_MODE.PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
            }
        };

        int paramsSize = Marshal.SizeOf<NativeMethods.AUDIOCLIENT_ACTIVATION_PARAMS>();
        IntPtr paramsPtr = Marshal.AllocHGlobal(paramsSize);
        try
        {
            Marshal.StructureToPtr(activationParams, paramsPtr, false);

            var propvariant = new NativeMethods.PROPVARIANT
            {
                vt = NativeMethods.VT_BLOB,
                blob = new NativeMethods.BLOB
                {
                    cbSize = (uint)paramsSize,
                    pBlobData = paramsPtr
                }
            };

            IntPtr propvariantPtr = Marshal.AllocHGlobal(Marshal.SizeOf<NativeMethods.PROPVARIANT>());
            try
            {
                Marshal.StructureToPtr(propvariant, propvariantPtr, false);

                var completionHandler = new ActivationCompletionHandler();
                Guid iidAudioClient = NativeMethods.IID_IAudioClient;

                int hr = NativeMethods.ActivateAudioInterfaceAsync(
                    NativeMethods.VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                    ref iidAudioClient,
                    propvariantPtr,
                    completionHandler,
                    out NativeMethods.IActivateAudioInterfaceAsyncOperation operation);

                if (hr != 0)
                {
                    throw new InvalidOperationException($"ActivateAudioInterfaceAsync devolvió HRESULT 0x{hr:X8}");
                }

                completionHandler.WaitForCompletion();

                if (completionHandler.ActivateResult != 0 || completionHandler.AudioClient == null)
                {
                    throw new InvalidOperationException($"La activación de loopback falló (HRESULT 0x{completionHandler.ActivateResult:X8}).");
                }

                CaptureLoop(completionHandler.AudioClient);
            }
            finally
            {
                Marshal.FreeHGlobal(propvariantPtr);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(paramsPtr);
        }
    }

    private static void CaptureLoop(NativeMethods.IAudioClient audioClient)
    {
        // Formato pedido: float32, 48kHz, 2 canales — el formato "mix" más
        // común que WASAPI shared-mode suele aceptar sin resamplear.
        var format = new NativeMethods.WAVEFORMATEX
        {
            wFormatTag = 3, // WAVE_FORMAT_IEEE_FLOAT
            nChannels = 2,
            nSamplesPerSec = 48000,
            wBitsPerSample = 32,
            cbSize = 0
        };
        format.nBlockAlign = (ushort)(format.nChannels * (format.wBitsPerSample / 8));
        format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

        const long REFTIMES_PER_SEC = 10_000_000;
        long bufferDuration = REFTIMES_PER_SEC / 2; // medio segundo de buffer

        int hr = audioClient.Initialize(
            NativeMethods.AUDCLNT_SHAREMODE.AUDCLNT_SHAREMODE_SHARED,
            NativeMethods.AUDCLNT_STREAMFLAGS_LOOPBACK,
            bufferDuration,
            0,
            ref format,
            Guid.Empty);
        if (hr != 0) throw new InvalidOperationException($"IAudioClient.Initialize falló (0x{hr:X8}).");

        Guid iidCaptureClient = NativeMethods.IID_IAudioCaptureClient;
        audioClient.GetService(ref iidCaptureClient, out object captureClientObj);
        var captureClient = (NativeMethods.IAudioCaptureClient)captureClientObj;

        Console.Error.WriteLine($"FORMAT {format.nSamplesPerSec} {format.nChannels}");
        Console.Error.Flush();

        var stopSignal = new ManualResetEvent(false);
        var stdinThread = new Thread(() =>
        {
            Console.In.ReadLine();
            stopSignal.Set();
        });
        stdinThread.IsBackground = true;
        stdinThread.Start();

        audioClient.Start();
        Stream stdout = Console.OpenStandardOutput();

        try
        {
            while (!stopSignal.WaitOne(10))
            {
                captureClient.GetNextPacketSize(out uint packetLength);
                while (packetLength != 0)
                {
                    captureClient.GetBuffer(out IntPtr dataPtr, out uint numFrames, out uint flags, out _, out _);

                    int bytes = (int)(numFrames * format.nBlockAlign);
                    if (bytes > 0)
                    {
                        byte[] buffer = new byte[bytes];
                        if ((flags & NativeMethods.AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                        {
                            Array.Clear(buffer, 0, buffer.Length);
                        }
                        else
                        {
                            Marshal.Copy(dataPtr, buffer, 0, bytes);
                        }
                        stdout.Write(buffer, 0, buffer.Length);
                    }

                    captureClient.ReleaseBuffer(numFrames);
                    captureClient.GetNextPacketSize(out packetLength);
                }
            }
        }
        finally
        {
            stdout.Flush();
            audioClient.Stop();
        }
    }

    private sealed class ActivationCompletionHandler : NativeMethods.IActivateAudioInterfaceCompletionHandler
    {
        private readonly ManualResetEvent _done = new ManualResetEvent(false);
        public int ActivateResult { get; private set; }
        public NativeMethods.IAudioClient AudioClient { get; private set; }

        public void ActivateCompleted(NativeMethods.IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            activateOperation.GetActivateResult(out int result, out object audioInterface);
            ActivateResult = result;
            if (result == 0) AudioClient = audioInterface as NativeMethods.IAudioClient;
            _done.Set();
        }

        public void WaitForCompletion() => _done.WaitOne(TimeSpan.FromSeconds(5));
    }
}
