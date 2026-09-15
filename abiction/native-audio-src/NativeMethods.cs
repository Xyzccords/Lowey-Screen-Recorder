// Declaraciones de interop para la API de "Process Loopback" de Windows.
// Ver el comentario grande al principio de Program.cs: esto nunca se
// compiló ni se probó en Windows real. Los GUIDs y layouts de structs están
// tomados de los headers públicos del SDK de Windows
// (mmdeviceapi.h/audioclient.h) y de la documentación/muestra oficial de
// Microsoft para "process loopback audio" (ApplicationLoopback).
using System;
using System.Runtime.InteropServices;

internal static class NativeMethods
{
    // --- user32 ---
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    // --- mmdevapi: activación asincrónica de una interfaz de audio ---
    public const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback";

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    public static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [ComImport]
    [Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport]
    [Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    // --- AUDIOCLIENT_ACTIVATION_PARAMS (para pedir loopback de un proceso puntual) ---
    public enum AUDIOCLIENT_ACTIVATION_TYPE
    {
        AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
    }

    public enum PROCESS_LOOPBACK_MODE
    {
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
    {
        public uint TargetProcessId;
        public PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        [FieldOffset(0)] public AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
        [FieldOffset(8)] public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    }

    // --- PROPVARIANT mínimo (solo el caso VT_BLOB, que es como se empaqueta
    // AUDIOCLIENT_ACTIVATION_PARAMS al llamar ActivateAudioInterfaceAsync) ---
    public const ushort VT_BLOB = 65;

    [StructLayout(LayoutKind.Sequential)]
    public struct BLOB
    {
        public uint cbSize;
        public IntPtr pBlobData;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public BLOB blob;
    }

    // --- WASAPI: IAudioClient / IAudioCaptureClient ---
    public enum AUDCLNT_SHAREMODE
    {
        AUDCLNT_SHAREMODE_SHARED = 0,
        AUDCLNT_SHAREMODE_EXCLUSIVE = 1
    }

    public const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    public const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    public static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    public static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    [ComImport]
    [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient
    {
        int Initialize(
            AUDCLNT_SHAREMODE shareMode,
            uint streamFlags,
            long hnsBufferDuration,
            long hnsPeriodicity,
            ref WAVEFORMATEX format,
            Guid audioSessionGuid);

        void GetBufferSize(out uint numBufferFrames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint numPaddingFrames);
        void IsFormatSupported(AUDCLNT_SHAREMODE shareMode, ref WAVEFORMATEX format, out IntPtr closestMatch);
        void GetMixFormat(out IntPtr deviceFormat);
        void GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr eventHandle);

        void GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient
    {
        void GetBuffer(out IntPtr dataBuffer, out uint numFramesToRead, out uint bufferFlags, out ulong devicePosition, out ulong qpcPosition);
        void ReleaseBuffer(uint numFramesRead);
        void GetNextPacketSize(out uint numFramesInNextPacket);
    }
}
