import { useEffect, useRef, useState } from 'react';
import { User, signOut } from 'firebase/auth';
import { ref, onValue, push, set } from 'firebase/database';
import { ref as sRef, uploadString, getDownloadURL } from 'firebase/storage';
import { auth, db, storage } from '../firebase-config';
import { LogOut, Camera, Square } from 'lucide-react';
import Chart from 'chart.js/auto';

declare global {
  interface Window {
    cv: any;
  }
}

interface DashboardProps {
  user: User;
}

interface MotionBox {
  x: number;
  y: number;
  w: number;
  h: number;
  a: number;
}

interface ROI {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CaptureData {
  url: string;
  timestamp: string;
}

export default function Dashboard({ user }: DashboardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const tempChartRef = useRef<HTMLCanvasElement>(null);
  const humChartRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const prevGrayRef = useRef<any>(null);
  const tempChartInstanceRef = useRef<Chart | null>(null);
  const humChartInstanceRef = useRef<Chart | null>(null);

  const [cvReady, setCvReady] = useState(false);
  const [fps, setFps] = useState(0);
  const [hasMotion, setHasMotion] = useState(false);
  const [eventCount, setEventCount] = useState(0);
  const [useROI, setUseROI] = useState(false);
  const [roi, setROI] = useState<ROI | null>(null);
  const [threshold, setThreshold] = useState(20);
  const [minArea, setMinArea] = useState(2500);
  const [cooldown, setCooldown] = useState(1200);
  const [beepEnabled, setBeepEnabled] = useState(false);
  const [alertVisible, setAlertVisible] = useState(false);
  const [alertDetail, setAlertDetail] = useState('');
  const [captures, setCaptures] = useState<CaptureData[]>([]);
  const lastEventTimeRef = useRef(0);
  const lastTsRef = useRef(performance.now());
  const draggingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  // Motion frequency tracking
  const motionTimestampsRef = useRef<number[]>([]);
  const [motionPerMinute, setMotionPerMinute] = useState(0);
  const [abnormalMotionAlert, setAbnormalMotionAlert] = useState(false);

  useEffect(() => {
    // Load OpenCV
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.x/opencv.js';
    script.async = true;
    document.body.appendChild(script);

    const interval = setInterval(() => {
      if (window.cv && window.cv.Mat) {
        setCvReady(true);
        clearInterval(interval);
      }
    }, 100);

    // Initialize charts
    if (tempChartRef.current && humChartRef.current) {
      const ctxTemp = tempChartRef.current.getContext('2d');
      const ctxHum = humChartRef.current.getContext('2d');

      if (ctxTemp) {
        tempChartInstanceRef.current = new Chart(ctxTemp, {
          type: 'line',
          data: {
            labels: [],
            datasets: [{
              label: 'Suhu (°C)',
              data: [],
              borderColor: 'rgb(255,99,132)',
              backgroundColor: 'rgba(255,99,132,0.1)',
              fill: true,
              tension: 0.3
            }]
          },
          options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: { min: 0, max: 60 }
            }
          }
        });
      }

      if (ctxHum) {
        humChartInstanceRef.current = new Chart(ctxHum, {
          type: 'line',
          data: {
            labels: [],
            datasets: [{
              label: 'Kelembapan (%)',
              data: [],
              borderColor: 'rgb(54,162,235)',
              backgroundColor: 'rgba(54,162,235,0.1)',
              fill: true,
              tension: 0.3
            }]
          },
          options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: { min: 0, max: 100 }
            }
          }
        });
      }
    }

    // Firebase realtime listener
    const dataRef = ref(db, 'inkubator/realtime');
    const unsubscribe = onValue(dataRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      const suhu = Number(data.suhu ?? NaN);
      const kelembapan = Number(data.kelembapan ?? NaN);
      const label = new Date().toLocaleTimeString('id-ID');

      if (tempChartInstanceRef.current && humChartInstanceRef.current) {
        tempChartInstanceRef.current.data.labels!.push(label);
        tempChartInstanceRef.current.data.datasets[0].data.push(isNaN(suhu) ? null : suhu);

        humChartInstanceRef.current.data.labels!.push(label);
        humChartInstanceRef.current.data.datasets[0].data.push(isNaN(kelembapan) ? null : kelembapan);

        if (tempChartInstanceRef.current.data.labels!.length > 30) {
          tempChartInstanceRef.current.data.labels!.shift();
          tempChartInstanceRef.current.data.datasets[0].data.shift();
          humChartInstanceRef.current.data.labels!.shift();
          humChartInstanceRef.current.data.datasets[0].data.shift();
        }

        tempChartInstanceRef.current.update();
        humChartInstanceRef.current.update();
      }
    });

    return () => {
      unsubscribe();
      if (tempChartInstanceRef.current) tempChartInstanceRef.current.destroy();
      if (humChartInstanceRef.current) humChartInstanceRef.current.destroy();
      stopCamera();
    };
  }, []);

  const handleLogout = async () => {
    try {
      stopCamera();
      await signOut(auth);
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const fitCanvas = () => {
    if (overlayRef.current && videoRef.current) {
      overlayRef.current.width = videoRef.current.videoWidth || 1280;
      overlayRef.current.height = videoRef.current.videoHeight || 720;
    }
  };

  const startCamera = async () => {
    try {
      if (streamRef.current) stopCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
        await videoRef.current.play();
        fitCanvas();
        loop();
      }
    } catch (e: any) {
      if (e.name === 'NotAllowedError') {
        alert('Akses kamera ditolak. Periksa izin browser.');
      } else if (e.name === 'NotFoundError') {
        alert('Tidak ada kamera ditemukan.');
      } else {
        alert('Tidak bisa mengakses kamera. Error: ' + e.message);
      }
      console.error(e);
    }
  };

  const stopCamera = () => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (overlayRef.current) {
      const ctx = overlayRef.current.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, overlayRef.current.width, overlayRef.current.height);
    }
    if (prevGrayRef.current) {
      prevGrayRef.current.delete();
      prevGrayRef.current = null;
    }
  };

  const toggleROI = () => {
    const newUseROI = !useROI;
    setUseROI(newUseROI);
    if (newUseROI && overlayRef.current) {
      const w = overlayRef.current.width * 0.6;
      const h = overlayRef.current.height * 0.6;
      setROI({
        x: (overlayRef.current.width - w) / 2,
        y: (overlayRef.current.height - h) / 2,
        w,
        h
      });
    } else {
      setROI(null);
    }
  };

  const captureSnapshot = async () => {
    if (!overlayRef.current || !videoRef.current) return;

    const snap = document.createElement('canvas');
    snap.width = overlayRef.current.width;
    snap.height = overlayRef.current.height;
    const sctx = snap.getContext('2d');
    if (!sctx) return;

    sctx.drawImage(videoRef.current, 0, 0, snap.width, snap.height);
    sctx.drawImage(overlayRef.current, 0, 0);
    const url = snap.toDataURL('image/jpeg', 0.9);

    // Upload to Firebase
    try {
      const filename = `captures/${Date.now()}.jpg`;
      const imageRef = sRef(storage, filename);
      await uploadString(imageRef, url, 'data_url');
      const downloadUrl = await getDownloadURL(imageRef);
      const timestamp = new Date().toISOString();
      const metaRef = push(ref(db, 'captures'));
      await set(metaRef, { timestamp, url: downloadUrl });
      
      setCaptures(prev => [{ url, timestamp }, ...prev]);
    } catch (err) {
      console.error('Upload error:', err);
      setCaptures(prev => [{ url, timestamp: new Date().toISOString() }, ...prev]);
    }
  };

  const playBeep = () => {
    if (!beepEnabled) return;
    const audio = new Audio('https://assets.mixkit.co/sfx/preview/mixkit-alarm-digital-clock-beep-989.mp3');
    audio.play().catch(() => {});
  };

  const playAbnormalBeep = () => {
    if (!beepEnabled) return;
    const audio = new Audio('https://assets.mixkit.co/sfx/preview/mixkit-alarm-digital-clock-beep-989.mp3');
    audio.play().catch(() => {});
    setTimeout(() => {
      const audio2 = new Audio('https://assets.mixkit.co/sfx/preview/mixkit-alarm-digital-clock-beep-989.mp3');
      audio2.play().catch(() => {});
    }, 300);
  };

  const saveMotionEvent = (boxCount: number, totalArea: number) => {
    try {
      const now = new Date().toISOString();
      const dataRef = push(ref(db, 'motion_events'));
      set(dataRef, { timestamp: now, boxCount, totalArea });
    } catch (err) {
      console.error('Save event error:', err);
    }
  };

  const saveAbnormalAlert = (motionsPerMin: number) => {
    try {
      const now = new Date().toISOString();
      const alertRef = push(ref(db, 'inkubator/alerts'));
      set(alertRef, {
        timestamp: now,
        type: 'abnormal_motion_frequency',
        motionsPerMinute: motionsPerMin,
        message: `Gerakan tidak normal: ${motionsPerMin} kali/menit (Normal: 6-9)`
      });
    } catch (err) {
      console.error('Save alert error:', err);
    }
  };

  const updateMotionFrequency = (hasMotionNow: boolean) => {
    const now = Date.now();
    const timestamps = motionTimestampsRef.current;

    // Remove timestamps older than 60 seconds
    const validTimestamps = timestamps.filter(ts => now - ts <= 60000);

    // Add new motion event
    if (hasMotionNow) {
      validTimestamps.push(now);
    }

    motionTimestampsRef.current = validTimestamps;
    const motionsPerMin = validTimestamps.length;
    setMotionPerMinute(motionsPerMin);

    // Check if abnormal (>9 per minute)
    if (motionsPerMin > 9) {
      if (!abnormalMotionAlert) {
        setAbnormalMotionAlert(true);
        playAbnormalBeep();
        saveAbnormalAlert(motionsPerMin);
      }
    } else {
      setAbnormalMotionAlert(false);
    }
  };

  const loop = () => {
    rafIdRef.current = requestAnimationFrame(loop);

    if (!cvReady || !videoRef.current || videoRef.current.readyState < 2 || !overlayRef.current) {
      updateFPS();
      return;
    }

    const cv = window.cv;
    const w = overlayRef.current.width;
    const h = overlayRef.current.height;
    const ctx = overlayRef.current.getContext('2d');
    if (!ctx) return;

    const frame = new cv.Mat(h, w, cv.CV_8UC4);
    const gray = new cv.Mat();
    const diff = new cv.Mat();
    const blur = new cv.Mat();
    const mask = new cv.Mat();

    ctx.drawImage(videoRef.current, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    frame.data.set(imgData.data);

    let rect = new cv.Rect(0, 0, w, h);
    if (useROI && roi) {
      rect = new cv.Rect(roi.x | 0, roi.y | 0, roi.w | 0, roi.h | 0);
    }

    cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    if (!prevGrayRef.current) {
      prevGrayRef.current = blur.clone();
      frame.delete();
      gray.delete();
      updateFPS();
      drawOverlay([], rect);
      return;
    }

    const currROI = blur.roi(rect);
    const prevROI = prevGrayRef.current.roi(rect);
    cv.absdiff(currROI, prevROI, diff);
    cv.threshold(diff, mask, threshold, 255, cv.THRESH_BINARY);
    cv.dilate(mask, mask, cv.Mat.ones(3, 3, cv.CV_8U));
    cv.erode(mask, mask, cv.Mat.ones(3, 3, cv.CV_8U));

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const boxes: MotionBox[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area >= minArea) {
        const r = cv.boundingRect(cnt);
        boxes.push({
          x: r.x + rect.x,
          y: r.y + rect.y,
          w: r.width,
          h: r.height,
          a: area
        });
      }
      cnt.delete();
    }

    const motionDetected = boxes.length > 0;
    setHasMotion(motionDetected);

    if (motionDetected) {
      const now = performance.now();
      if (now - lastEventTimeRef.current > cooldown) {
        lastEventTimeRef.current = now;
        setEventCount(prev => prev + 1);
        setAlertVisible(true);
        const totalArea = boxes.reduce((s, b) => s + b.a, 0) | 0;
        setAlertDetail(`Jumlah objek: ${boxes.length}, total area: ${totalArea.toFixed(0)} px`);
        playBeep();
        saveMotionEvent(boxes.length, totalArea);
      }
    } else {
      setAlertVisible(false);
    }

    // Update motion frequency
    updateMotionFrequency(motionDetected);

    drawOverlay(boxes, rect);

    prevGrayRef.current.delete();
    prevGrayRef.current = blur.clone();
    frame.delete();
    gray.delete();
    diff.delete();
    mask.delete();
    contours.delete();
    hierarchy.delete();
    currROI.delete();
    prevROI.delete();
    updateFPS();
  };

  const updateFPS = () => {
    const now = performance.now();
    const dt = now - lastTsRef.current;
    lastTsRef.current = now;
    const calculatedFps = Math.max(1, Math.round(1000 / dt));
    setFps(calculatedFps);
  };

  const drawOverlay = (boxes: MotionBox[], rect: any) => {
    if (!overlayRef.current || !videoRef.current) return;
    const ctx = overlayRef.current.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(videoRef.current, 0, 0, overlayRef.current.width, overlayRef.current.height);

    if (useROI && rect) {
      ctx.save();
      ctx.strokeStyle = 'rgba(16,185,129,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(239,68,68,0.9)';
    ctx.lineWidth = 3;
    boxes.forEach(b => ctx.strokeRect(b.x, b.y, b.w, b.h));
    ctx.restore();
  };

  // Mouse handlers for ROI dragging
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!useROI || !roi || !overlayRef.current) return;
    const r = overlayRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x > roi.x && x < roi.x + roi.w && y > roi.y && y < roi.y + roi.h) {
      draggingRef.current = true;
      dragOffsetRef.current = { x: x - roi.x, y: y - roi.y };
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current || !roi || !overlayRef.current) return;
    const r = overlayRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    setROI({
      ...roi,
      x: Math.max(0, Math.min(overlayRef.current.width - roi.w, x - dragOffsetRef.current.x)),
      y: Math.max(0, Math.min(overlayRef.current.height - roi.h, y - dragOffsetRef.current.y))
    });
  };

  const handleMouseUp = () => {
    draggingRef.current = false;
  };

  return (
    <div className="min-h-screen p-6 bg-gradient-to-b from-blue-50 to-white">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header with Logout */}
        <header className="text-center relative">
          <button
            onClick={handleLogout}
            className="absolute right-0 top-0 flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
          <h1 className="text-blue-800">Realtime Motion Detection</h1>
          <p className="text-blue-600">Deteksi gerakan via kamera (frame differencing + contour)</p>
          <p className="text-sm text-red-600 mt-2">⚠️ Untuk mengakses kamera: jalankan via <strong>HTTPS</strong> atau <strong>localhost</strong> & beri izin kamera.</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Video & Overlay */}
          <div className="lg:col-span-2 bg-white rounded-2xl p-4 shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-blue-800">Kamera</h2>
              <div className="text-sm text-slate-500">FPS: {fps}</div>
            </div>

            <div className="relative rounded-xl overflow-hidden">
              <video
                ref={videoRef}
                className="w-full h-auto bg-slate-100"
                autoPlay
                playsInline
                muted
              />
              <canvas
                ref={overlayRef}
                className="absolute inset-0 cursor-move"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                onClick={startCamera}
                className="px-5 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition-colors flex items-center gap-2"
              >
                <Camera className="w-4 h-4" />
                Start Camera
              </button>
              <button
                onClick={stopCamera}
                className="px-5 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 transition-colors flex items-center gap-2"
              >
                <Square className="w-4 h-4" />
                Stop
              </button>
              <button
                onClick={toggleROI}
                className={`px-5 py-2 rounded-xl ${useROI ? 'bg-emerald-600 text-white' : 'bg-slate-200'} hover:opacity-90 transition-colors`}
              >
                ROI: {useROI ? 'On' : 'Off'}
              </button>
              <button
                onClick={captureSnapshot}
                className="px-5 py-2 rounded-xl bg-purple-600 text-white hover:bg-purple-700 transition-colors"
              >
                Capture
              </button>
              <label className="flex items-center gap-2 text-sm ml-auto cursor-pointer">
                <input
                  type="checkbox"
                  checked={beepEnabled}
                  onChange={(e) => setBeepEnabled(e.target.checked)}
                  className="w-4 h-4"
                />
                Bunyi saat gerakan
              </label>
            </div>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-blue-50 p-3 rounded-xl">
                <p className="text-xs text-blue-700">Threshold</p>
                <input
                  type="range"
                  min="5"
                  max="60"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="w-full"
                />
                <div className="text-sm">{threshold}</div>
              </div>
              <div className="bg-teal-50 p-3 rounded-xl">
                <p className="text-xs text-teal-700">Min Area (px)</p>
                <input
                  type="range"
                  min="200"
                  max="20000"
                  value={minArea}
                  onChange={(e) => setMinArea(Number(e.target.value))}
                  className="w-full"
                />
                <div className="text-sm">{minArea}</div>
              </div>
              <div className="bg-amber-50 p-3 rounded-xl">
                <p className="text-xs text-amber-700">Cooldown (ms)</p>
                <input
                  type="range"
                  min="300"
                  max="5000"
                  value={cooldown}
                  onChange={(e) => setCooldown(Number(e.target.value))}
                  className="w-full"
                />
                <div className="text-sm">{cooldown}</div>
              </div>
            </div>

            {/* Charts */}
            <div className="mt-6">
              <h3 className="text-slate-800 mb-2">Grafik Suhu (30 detik)</h3>
              <div className="h-32">
                <canvas ref={tempChartRef}></canvas>
              </div>
            </div>
            <div className="mt-6">
              <h3 className="text-slate-800 mb-2">Grafik Kelembapan (30 detik)</h3>
              <div className="h-32">
                <canvas ref={humChartRef}></canvas>
              </div>
            </div>
          </div>

          {/* Status Panel */}
          <div className="bg-white rounded-2xl p-4 shadow-lg space-y-4">
            <h2 className="text-blue-800">Status</h2>
            
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-green-50 p-3 rounded-xl">
                <p className="text-xs text-green-700">Gerakan Terdeteksi</p>
                <p className="text-green-900">{hasMotion ? 'Ya' : 'Tidak'}</p>
              </div>
              <div className="bg-indigo-50 p-3 rounded-xl">
                <p className="text-xs text-indigo-700">Hitungan Event</p>
                <p className="text-indigo-900">{eventCount}</p>
              </div>
            </div>

            <div className="bg-violet-50 p-3 rounded-xl">
              <p className="text-xs text-violet-700">Frekuensi Gerakan</p>
              <p className="text-violet-900">{motionPerMinute} kali/menit</p>
              <p className="text-xs text-violet-600 mt-1">Normal: 6-9 kali/menit</p>
            </div>

            {/* Normal Motion Alert */}
            {alertVisible && (
              <div className="bg-red-50 border border-red-200 p-3 rounded-xl">
                <div className="text-red-800">ALERT: Gerakan besar terdeteksi!</div>
                <div className="text-red-700 text-sm">{alertDetail}</div>
              </div>
            )}

            {/* Abnormal Motion Frequency Alert */}
            {abnormalMotionAlert && (
              <div className="bg-red-600 border-2 border-red-800 p-4 rounded-xl animate-pulse">
                <div className="text-white">⚠️ GERAKAN BAYI TIDAK NORMAL</div>
                <div className="text-red-100 text-sm mt-1">
                  Frekuensi: {motionPerMinute} kali/menit
                </div>
                <div className="text-red-100 text-xs mt-1">
                  (Normal: 6-9 kali/menit)
                </div>
              </div>
            )}

            <div>
              <h3 className="text-slate-800 mb-2">Hasil Tangkapan</h3>
              <div className="grid grid-cols-2 gap-2 max-h-60 overflow-auto">
                {captures.map((capture, idx) => (
                  <div key={idx} className="border rounded-xl overflow-hidden">
                    <img src={capture.url} alt="Capture" className="w-full h-28 object-cover" />
                    <div className="p-2 text-xs text-slate-600">
                      {new Date(capture.timestamp).toLocaleString('id-ID')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
