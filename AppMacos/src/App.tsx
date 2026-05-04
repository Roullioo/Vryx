import { useState, useEffect } from 'react';
import { Play, Pause, Activity, Cpu as Gpu, TrendingUp, MessageSquare, Send, Power } from 'lucide-react';
import { useVryxNode } from './useVryxNode';

const INITIAL_STATS = {
  memoryFactor: '×0.96',
  grossMonthly: '30,83 €',
  electricMonthly: '−7,27 €',
  netMonthly: '23,56 €',
  roi: '15 mois',
  modeMultiplier: '×1.06',
};
console.log(INITIAL_STATS); // For potential future use

type WorkerState = 'stopped' | 'searching' | 'connecting' | 'working';

function App() {
  const [workerState, setWorkerState] = useState<WorkerState>('stopped');
  const [progress, setProgress] = useState(0);
  const [chatInput, setChatInput] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [realTimeEarnings, setRealTimeEarnings] = useState(0);
  const [user, setUser] = useState<any>(JSON.parse(localStorage.getItem('vryx_user') || 'null'));
  const [loginError, setLoginError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'initiator' | 'worker'>(
    (import.meta.env.VITE_VRYX_ROLE as 'initiator' | 'worker') || 'worker'
  );

  const { status, isOnline, tokens, isGenerating, startChat } = useVryxNode();

  useEffect(() => {
    // Check if role is explicitly passed via Electron (as fallback)
    // @ts-ignore
    if (window.electron && window.electron.getRole) {
      // @ts-ignore
      const electronRole = window.electron.getRole();
      if (electronRole) setRole(electronRole);
    }
  }, []);

  useEffect(() => {
    // Sync credits with real-time earnings
    if (status) {
      // 0.24 EUR per 1 Million tokens (rough estimate)
      setRealTimeEarnings(status.tokens_generated * 0.00000024);
    }
  }, [status]);

  useEffect(() => {
    try {
      // Fetch real hardware stats on mount
      // @ts-ignore
      if (window.electron && window.electron.getHardwareStats) {
        // @ts-ignore
        window.electron.getHardwareStats().then((data: any) => {
          if (data) console.log('Hardware stats:', data);
        }).catch((err: any) => console.warn('Hardware stats unavailable:', err));
        
        // @ts-ignore
        window.electron.onWorkerStatus((status: any) => {
          if (status && status.state) setWorkerState(status.state);
          if (status && status.progress !== undefined) setProgress(status.progress);
        });
      }
    } catch (e) {
      console.error('Fatal mount error:', e);
    }
  }, []);

  if (!role) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-white font-mono">
        <Activity className="animate-spin mr-2" /> Initializing Vryx...
      </div>
    );
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('https://vryx.eu/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('vryx_user', JSON.stringify(data.user));
        setUser(data.user);
      } else {
        setLoginError(data.error || 'Erreur de connexion');
      }
    } catch (err) {
      setLoginError('Impossible de contacter le serveur.');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('vryx_user');
    setUser(null);
    if (workerState !== 'stopped') toggleWorker();
  };

  const toggleWorker = () => {
    if (workerState === 'working' || workerState === 'searching' || workerState === 'connecting') {
      // @ts-ignore
      if (window.electron) window.electron.stopWorker();
      setWorkerState('stopped');
      setProgress(0);
    } else {
      // @ts-ignore
      if (window.electron) window.electron.startWorker(user?.id);
      setWorkerState('searching');
      setProgress(10);
    }
  };

  const handleSendChat = () => {
    if (chatInput.trim()) {
      startChat(chatInput);
      setChatInput('');
    }
  };

  const getStatusText = () => {
    if (workerState === 'stopped') return 'EN PAUSE';
    if (!isOnline && workerState === 'working') return 'ENGINE OFFLINE';
    switch (workerState) {
      case 'searching': return 'RECHERCHE DU NOEUD...';
      case 'connecting': return 'CONNEXION EN COURS...';
      case 'working': return 'TRAVAIL EN COURS';
      default: return 'EN PAUSE';
    }
  };

  const getStatusColor = () => {
    if (workerState === 'stopped') return 'text-muted';
    if (!isOnline && workerState === 'working') return 'text-alert';
    switch (workerState) {
      case 'searching': return 'text-warning';
      case 'connecting': return 'text-accent';
      case 'working': return 'text-success';
      default: return 'text-muted';
    }
  };

  const isWorking = workerState === 'working' && isOnline;
  const isTransitioning = (workerState === 'searching' || workerState === 'connecting') && isOnline;

  if (!user) {
    return (
      <div className="flex flex-col h-screen bg-bg text-fg font-sans p-8 items-center justify-center relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[300px] h-[150px] bg-primary/20 blur-[100px] pointer-events-none" />
        
        <img src="./logo-withoutbg.png" alt="Vryx Logo" className="w-20 h-20 mb-8 drop-shadow-[0_0_15px_rgba(59,130,246,0.5)]" />
        
        <div className="w-full max-w-sm space-y-6 panel p-8 relative z-10 border-primary/20">
          <div className="text-center">
            <h2 className="text-2xl font-display font-black tracking-tighter text-white italic">CONNEXION VRYX</h2>
            <p className="text-xs text-muted mt-2">Accédez à votre console de minage IA</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase tracking-widest mb-1.5 ml-1">Email</label>
              <input 
                type="email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:border-primary/50 focus:outline-none transition-all"
                placeholder="nom@exemple.com"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase tracking-widest mb-1.5 ml-1">Mot de passe</label>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:border-primary/50 focus:outline-none transition-all"
                placeholder="••••••••••••"
              />
            </div>

            {loginError && <p className="text-[10px] font-bold text-alert text-center uppercase tracking-tighter">{loginError}</p>}

            <button 
              type="submit"
              className="w-full bg-primary hover:bg-primary/90 text-white font-bold py-3 rounded-xl shadow-lg shadow-primary/20 transition-all active:scale-[0.98]"
            >
              SE CONNECTER
            </button>
          </form>

          <p className="text-[10px] text-center text-muted uppercase tracking-widest leading-relaxed">
            Pas encore de compte ? <br/> 
            <a href="https://vryx.eu" target="_blank" rel="noreferrer" className="text-primary hover:underline">Inscrivez-vous sur le site</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-bg text-fg font-sans overflow-hidden relative">
      {/* Glow effect at the top */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[200px] h-[100px] bg-primary/20 blur-[80px] pointer-events-none" />

      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-10 pb-4 drag-region">
        <div className="flex items-center gap-3">
          <div className="relative">
            <img src="./logo-withoutbg.png" alt="Vryx" className="w-10 h-10 drop-shadow-[0_0_8px_rgba(59,130,246,0.3)]" />
            {isOnline && <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-success rounded-full border-2 border-bg animate-pulse" />}
          </div>
          <div>
            <h1 className="text-2xl font-display font-black tracking-tighter text-white leading-none italic">VRYX</h1>
            <p className="text-[9px] font-bold text-primary tracking-[0.2em] mt-1 uppercase opacity-80">
              {role === 'worker' ? 'GPU COMPUTE NODE' : 'AI DISTRIBUTED NODE'}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end group">
          <span className="text-[9px] font-bold text-muted uppercase tracking-widest">{user?.email.split('@')[0]}</span>
          <button 
            onClick={handleLogout}
            className="text-[9px] font-bold text-alert uppercase tracking-tighter opacity-0 group-hover:opacity-100 transition-opacity"
          >
            Déconnexion
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-5 scrollbar-hide">
        
        {/* Main Status Card */}
        <div className="panel p-6 flex flex-col items-center justify-center relative overflow-hidden group border-primary/10">
          <div className={`absolute inset-0 transition-opacity duration-1000 ${isWorking ? 'opacity-100' : 'opacity-0'}`}>
            <div className="absolute inset-0 bg-gradient-to-b from-success/10 to-transparent" />
            <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-success/20 blur-[60px] animate-pulse" />
          </div>

          <div className="text-center z-10 mb-6">
            <p className="text-[10px] font-bold text-muted tracking-widest uppercase mb-2">Tokens P2P Générés</p>
            <h2 className="text-5xl font-display font-bold tracking-tight text-white flex items-baseline justify-center gap-2">
              {status?.tokens_generated || 0}<span className="text-primary text-xl font-black italic">V</span>
            </h2>
            <div className="mt-2 flex justify-center gap-4 text-[10px] font-mono text-muted uppercase tracking-wider">
               <span>In: <span className="text-fg">{status?.tokens_in || 0}</span></span>
               <span>Out: <span className="text-fg">{status?.tokens_out || 0}</span></span>
            </div>
          </div>

          <button
            onClick={toggleWorker}
            className={`no-drag relative group flex items-center justify-center w-24 h-24 rounded-full mb-4 transition-all duration-500 ease-out transform active:scale-95 shadow-2xl ${
              workerState === 'stopped'
                ? 'bg-white text-black hover:scale-105'
                : isWorking 
                ? 'bg-success shadow-success/40 ring-4 ring-success/20' 
                : isTransitioning
                ? 'bg-warning shadow-warning/40 animate-pulse'
                : 'bg-white/10 text-muted opacity-50 cursor-not-allowed'
            }`}
          >
            {workerState === 'working' && isOnline ? (
              <Pause size={36} fill="currentColor" />
            ) : isTransitioning ? (
              <Activity size={36} className="animate-spin" />
            ) : (
              <Play size={36} fill="currentColor" className="ml-1" />
            )}
          </button>

          <div className="flex flex-col items-center z-10 w-full">
            <span className={`text-[11px] font-bold tracking-[0.15em] uppercase ${getStatusColor()}`}>
              {getStatusText()}
            </span>
            {isTransitioning && (
              <div className="w-full max-w-[140px] h-1 bg-white/5 rounded-full mt-3 overflow-hidden">
                <div 
                  className={`h-full transition-all duration-75 ease-linear ${workerState === 'searching' ? 'bg-warning' : 'bg-accent'}`}
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>
        </div>

        {role === 'worker' && status?.last_shard_trace && (
          <div className="panel p-3 border-primary/15">
            <p className="text-[9px] font-bold text-muted uppercase tracking-widest mb-1">Shard RAM (temps réel)</p>
            <p className="text-[10px] font-mono text-fg leading-snug break-all">
              {status.last_shard_trace.dtype || '—'} · session {status.last_shard_trace.shard_session_id || '—'}
            </p>
          </div>
        )}

        {/* Node & Network Stats */}
        <div className="grid grid-cols-3 gap-3">
          <div className="panel p-3 flex flex-col items-center gap-2">
            <Activity size={14} className="text-primary" />
            <div className="text-center">
              <p className="text-[9px] font-bold text-muted uppercase tracking-tighter">Peers</p>
              <p className="text-[11px] font-bold text-white leading-tight">{status?.active_connections || 0}</p>
            </div>
          </div>
          <div className="panel p-3 flex flex-col items-center gap-2">
            <Gpu size={14} className="text-muted" />
            <div className="text-center">
              <p className="text-[9px] font-bold text-muted uppercase tracking-tighter">Engine</p>
              <p className="text-[11px] font-bold text-white leading-tight">9B-P2P</p>
            </div>
          </div>
          <div className="panel p-3 flex flex-col items-center gap-2">
            <TrendingUp size={14} className="text-muted" />
            <div className="text-center">
              <p className="text-[9px] font-bold text-muted uppercase tracking-tighter">Earnings</p>
              <p className="text-[11px] font-bold text-white leading-tight">{realTimeEarnings.toFixed(4)}€</p>
            </div>
          </div>
        </div>

        {/* Chat Section */}
        <div className="panel overflow-hidden border-primary/5">
          <div className="bg-white/5 px-4 py-2 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageSquare size={12} className="text-primary" />
              <span className="text-[10px] font-bold text-muted tracking-widest uppercase">Live Trace</span>
            </div>
            <button 
              onClick={() => setShowChat(!showChat)}
              className="text-[9px] font-bold text-primary uppercase hover:underline"
            >
              {showChat ? 'Réduire' : 'Agrandir'}
            </button>
          </div>
          
          {showChat && (
            <div className="p-4 flex flex-col h-[200px]">
              <div className="flex-1 overflow-y-auto space-y-3 mb-4 pr-2 scrollbar-hide font-mono text-[11px]">
                {role === 'worker' ? (
                  <p className="text-primary animate-pulse">Running as Compute Worker - Listening for tasks...</p>
                ) : tokens.length === 0 && !isGenerating ? (
                  <p className="text-muted italic">Prêt pour l'inférence P2P...</p>
                ) : (
                  <div className="text-white leading-relaxed whitespace-pre-wrap">
                    {tokens.join('')}
                    {isGenerating && <span className="inline-block w-1.5 h-4 bg-primary ml-1 animate-pulse" />}
                  </div>
                )}
              </div>
              {role === 'initiator' && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
                    placeholder="Posez une question au réseau..."
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-[12px] focus:outline-none focus:border-primary/50"
                  />
                  <button 
                    onClick={handleSendChat}
                    disabled={!isOnline || isGenerating}
                    className="bg-primary hover:bg-primary/80 disabled:opacity-50 p-2 rounded-xl transition-colors"
                  >
                    <Send size={16} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="text-center pt-2">
          <p className="text-[9px] text-muted font-medium uppercase tracking-[0.2em] opacity-50 flex items-center justify-center gap-2">
            <Power size={8} className={isOnline ? 'text-success' : 'text-alert'} />
            Vryx Protocol V3.2.0
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;
