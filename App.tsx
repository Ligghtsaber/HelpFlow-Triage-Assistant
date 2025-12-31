
import React, { useState, useEffect, useRef } from 'react';
import { AccountTier, TriageInput, TriageResult, HistoryItem, Priority, LiveTranscription } from './types';
import { triageMessage, createPcmBlob, decodeBase64, decodeAudioData } from './geminiService';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';

const App: React.FC = () => {
  const [input, setInput] = useState<TriageInput>({
    customer_message: '',
    account_tier: AccountTier.Free,
    recent_activity_summary: '',
    use_search: false
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HistoryItem | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const saved = localStorage.getItem('helpflow_history');
    if (!saved) return [];
    try {
      return JSON.parse(saved).map((h: any) => ({ ...h, timestamp: new Date(h.timestamp) }));
    } catch {
      return [];
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  // Live Audio State
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [liveTranscription, setLiveTranscription] = useState<LiveTranscription[]>([]);
  const audioContextsRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  useEffect(() => {
    localStorage.setItem('helpflow_history', JSON.stringify(history));
  }, [history]);

  const handleTriage = async (e?: React.FormEvent, overrideInput?: TriageInput) => {
    e?.preventDefault();
    const finalInput = overrideInput || input;
    if (!finalInput.customer_message.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const triaged = await triageMessage(finalInput);
      
      const newHistoryItem: HistoryItem = {
        ...triaged,
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date(),
        input: { ...finalInput }
      };
      setResult(newHistoryItem);
      setHistory(prev => [newHistoryItem, ...prev]);
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred during triage.");
    } finally {
      setLoading(false);
    }
  };

  const startLiveTriage = async () => {
    setIsLiveMode(true);
    setError(null);
    setLiveTranscription([]);
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextsRef.current = { input: inputCtx, output: outputCtx };

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: 'You are a supportive and professional HelpFlow intake agent. Listen to the customer\'s issue. Be brief and empathetic. Once you have enough details, summarize the problem clearly.'
        },
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const pcmBlob = createPcmBlob(e.inputBuffer.getChannelData(0));
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
            (scriptProcessor as any)._cleanup = () => {
              source.disconnect();
              scriptProcessor.disconnect();
            };
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.inputTranscription) {
              const text = msg.serverContent.inputTranscription.text;
              setLiveTranscription(prev => [...prev, { text, isUser: true }]);
            }
            if (msg.serverContent?.outputTranscription) {
              const text = msg.serverContent.outputTranscription.text;
              setLiveTranscription(prev => [...prev, { text, isUser: false }]);
            }

            const base64Audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const outCtx = audioContextsRef.current?.output;
              if (!outCtx) return;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const buffer = await decodeAudioData(decodeBase64(base64Audio), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outCtx.destination);
              source.onended = () => activeSourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              activeSourcesRef.current.add(source);
            }

            if (msg.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => s.stop());
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError("Failed to start live triage: " + err.message);
      stopLiveTriage();
    }
  };

  const stopLiveTriage = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioContextsRef.current) {
      audioContextsRef.current.input.close();
      audioContextsRef.current.output.close();
      audioContextsRef.current = null;
    }
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    setIsLiveMode(false);

    // After stopping, if we have a transcription, let's auto-triage it
    if (liveTranscription.length > 0) {
      const fullTranscript = liveTranscription
        .filter(t => t.isUser)
        .map(t => t.text)
        .join(' ');
      
      if (fullTranscript.trim()) {
        const liveInput = { ...input, customer_message: fullTranscript };
        setInput(liveInput);
        handleTriage(undefined, liveInput);
      }
    }
  };

  const applyTemplate = (template: Partial<TriageInput>) => {
    setInput({ ...input, ...template });
  };

  const clearForm = () => {
    setInput({
      customer_message: '',
      account_tier: AccountTier.Free,
      recent_activity_summary: '',
      use_search: false
    });
    setResult(null);
    setError(null);
  };

  const clearHistory = () => {
    if (confirm('Are you sure?')) {
      setHistory([]);
      localStorage.removeItem('helpflow_history');
    }
  };

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopyStatus(type);
    setTimeout(() => setCopyStatus(null), 2000);
  };

  const getPriorityStyles = (priority: Priority) => {
    switch (priority) {
      case Priority.High: return 'bg-rose-100 text-rose-700 border-rose-200';
      case Priority.Medium: return 'bg-amber-100 text-amber-700 border-amber-200';
      case Priority.Low: return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  const templates = [
    {
      label: 'CSV Crash (Pro)',
      data: { customer_message: "My app crashes when I upload CSV", account_tier: AccountTier.Pro, recent_activity_summary: "Upgraded plan yesterday" }
    },
    {
      label: 'Double Charge (Ent)',
      data: { customer_message: "I was charged twice for last month", account_tier: AccountTier.Enterprise, recent_activity_summary: "Invoice generated last week" }
    },
    {
      label: 'Intermittent Lag (Free)',
      data: { customer_message: "It’s slow sometimes, not sure why", account_tier: AccountTier.Free, recent_activity_summary: "" }
    }
  ];

  return (
    <div className="min-h-screen bg-[#f8fafc] flex flex-col selection:bg-indigo-100 selection:text-indigo-900">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 h-16 flex items-center shrink-0 shadow-sm sticky top-0 z-50">
        <div className="max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-indigo-600 w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-100 ring-2 ring-indigo-50">
              <i className="fas fa-bolt-auto text-white text-lg"></i>
            </div>
            <h1 className="text-lg font-bold text-slate-900 tracking-tight">
              HelpFlow <span className="text-indigo-600 font-extrabold ml-1">Triage</span>
            </h1>
          </div>
          <div className="flex items-center space-x-4">
            <div className="hidden md:flex items-center space-x-2 bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-100">
               <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
               <span className="text-[10px] font-black text-emerald-700 uppercase tracking-widest">System Ready</span>
            </div>
            <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center overflow-hidden">
               <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Felix" alt="avatar" />
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] w-full mx-auto p-4 sm:p-6 lg:p-8 flex-1 flex flex-col gap-8 lg:flex-row">
        
        {/* Left Column: Intake */}
        <div className="lg:w-[400px] shrink-0 space-y-6">
          <section className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Input Control</h2>
              <button onClick={clearForm} className="text-slate-300 hover:text-slate-600 transition-colors">
                <i className="fas fa-rotate-right text-xs"></i>
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Voice Button */}
              <button
                onClick={isLiveMode ? stopLiveTriage : startLiveTriage}
                className={`w-full py-4 rounded-2xl flex items-center justify-center space-x-3 transition-all border-2 ${
                  isLiveMode 
                    ? 'bg-rose-50 border-rose-200 text-rose-600 animate-pulse' 
                    : 'bg-indigo-50 border-indigo-100 text-indigo-600 hover:bg-indigo-100'
                } text-[11px] font-black uppercase tracking-widest`}
              >
                <i className={`fas ${isLiveMode ? 'fa-stop-circle' : 'fa-microphone'} text-lg`}></i>
                <span>{isLiveMode ? 'Stop Listening' : 'Voice Intake'}</span>
              </button>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                   <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Templates</label>
                </div>
                <div className="flex flex-wrap gap-2">
                  {templates.map(t => (
                    <button 
                      key={t.label}
                      onClick={() => applyTemplate(t.data)}
                      className="text-[9px] font-bold px-3 py-1.5 bg-slate-50 text-slate-600 rounded-lg border border-slate-100 hover:bg-slate-100 transition-all"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <form onSubmit={handleTriage} className="space-y-5">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Message Content</label>
                  <textarea
                    required
                    className="w-full h-48 px-4 py-3 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 transition-all resize-none text-[13px] font-medium leading-relaxed"
                    placeholder="Paste customer query here..."
                    value={input.customer_message}
                    onChange={(e) => setInput({...input, customer_message: e.target.value})}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Tier</label>
                    <select
                      className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 text-[12px] font-bold"
                      value={input.account_tier}
                      onChange={(e) => setInput({...input, account_tier: e.target.value as AccountTier})}
                    >
                      {Object.values(AccountTier).map(tier => <option key={tier} value={tier}>{tier}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Recent Context</label>
                    <input
                      type="text"
                      className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-500/10 text-[12px] font-medium"
                      placeholder="e.g. Plan upgrade"
                      value={input.recent_activity_summary}
                      onChange={(e) => setInput({...input, recent_activity_summary: e.target.value})}
                    />
                  </div>
                </div>

                <div className="flex items-center space-x-3 px-1">
                  <input
                    type="checkbox"
                    id="useSearch"
                    checked={input.use_search}
                    onChange={(e) => setInput({...input, use_search: e.target.checked})}
                    className="w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500"
                  />
                  <label htmlFor="useSearch" className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center">
                    Enable Search Grounding <i className="fas fa-globe-americas ml-2 text-indigo-400"></i>
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={loading || !input.customer_message.trim()}
                  className={`w-full py-4 rounded-2xl font-black text-white transition-all shadow-xl uppercase text-[11px] tracking-widest ${
                    loading || !input.customer_message.trim()
                      ? 'bg-slate-300 cursor-not-allowed'
                      : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-100'
                  }`}
                >
                  {loading ? <i className="fas fa-circle-notch fa-spin"></i> : 'Analyze Ticket'}
                </button>
              </form>
            </div>
          </section>

          {/* History */}
          <section className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden flex flex-col flex-1 max-h-[400px]">
             <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Analysis Logs</h3>
                {history.length > 0 && (
                  <button onClick={clearHistory} className="text-[9px] font-bold text-rose-500 hover:underline">Clear</button>
                )}
             </div>
             <div className="overflow-y-auto divide-y divide-slate-50">
               {history.length > 0 ? history.map(item => (
                 <button 
                  key={item.id} 
                  onClick={() => setResult(item)}
                  className={`w-full p-4 text-left hover:bg-slate-50 transition-colors flex flex-col gap-1 ${result?.id === item.id ? 'bg-indigo-50/50' : ''}`}
                 >
                    <div className="flex items-center justify-between">
                      <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded border ${getPriorityStyles(item.priority as Priority)}`}>{item.priority}</span>
                      <span className="text-[8px] text-slate-400">{item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="text-xs font-bold text-slate-800 line-clamp-1">{item.summary}</p>
                 </button>
               )) : (
                 <div className="p-10 text-center text-slate-300">
                    <i className="fas fa-history mb-2 text-xl block"></i>
                    <p className="text-[10px] font-black uppercase tracking-widest">No Logs Yet</p>
                 </div>
               )}
             </div>
          </section>
        </div>

        {/* Right Column: Content */}
        <div className="flex-1 flex flex-col space-y-6">
          {isLiveMode ? (
            <div className="flex-1 bg-white rounded-[40px] border border-slate-200 p-12 flex flex-col items-center justify-center space-y-8 animate-in fade-in zoom-in-95 duration-300">
              <div className="relative">
                <div className="w-40 h-40 rounded-full bg-indigo-50 border-4 border-indigo-100 flex items-center justify-center animate-pulse">
                   <i className="fas fa-microphone text-5xl text-indigo-600"></i>
                </div>
                <div className="absolute -top-4 -right-4 bg-emerald-500 text-white px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest shadow-lg">
                   Live
                </div>
              </div>
              <div className="text-center space-y-3">
                <h3 className="text-2xl font-black text-slate-900 tracking-tight">Active Voice Triage</h3>
                <p className="text-sm text-slate-500 font-medium max-w-sm">
                  The session is currently recording. Speak naturally to describe the issue. HelpFlow is listening to triage in real-time.
                </p>
              </div>
              <div className="w-full max-w-lg bg-slate-50 rounded-3xl p-6 h-64 overflow-y-auto border border-slate-100 flex flex-col space-y-4">
                {liveTranscription.length > 0 ? liveTranscription.map((t, i) => (
                  <div key={i} className={`flex ${t.isUser ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] px-4 py-2 rounded-2xl text-[13px] font-medium ${t.isUser ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 border border-slate-100'}`}>
                      {t.text}
                    </div>
                  </div>
                )) : (
                  <p className="text-center text-slate-300 text-xs font-bold uppercase tracking-widest mt-20">Awaiting audio input...</p>
                )}
              </div>
              <button 
                onClick={stopLiveTriage}
                className="px-10 py-4 bg-slate-900 text-white rounded-2xl text-[11px] font-black uppercase tracking-widest shadow-xl hover:bg-slate-800 transition-all active:scale-95"
              >
                End Session & Analyze
              </button>
            </div>
          ) : result ? (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6">
              {/* Triage Dashboard */}
              <div className="bg-white rounded-[40px] shadow-2xl shadow-slate-200 border border-slate-200 overflow-hidden">
                <div className={`h-2 w-full ${result.priority === Priority.High ? 'bg-rose-500' : result.priority === Priority.Medium ? 'bg-amber-500' : 'bg-emerald-500'}`}></div>
                
                <div className="p-8 lg:p-12">
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-8 mb-12">
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <span className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest border ${getPriorityStyles(result.priority as Priority)}`}>
                          {result.priority} Priority
                        </span>
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest bg-slate-50 px-3 py-1.5 rounded-full border border-slate-100">
                          ID: {result.id.toUpperCase()}
                        </span>
                      </div>
                      <h2 className="text-4xl font-black text-slate-900 leading-tight tracking-tight">
                        {result.summary}
                      </h2>
                    </div>
                    <div className="flex items-center gap-4">
                      <button 
                        onClick={() => copyToClipboard(JSON.stringify(result, null, 2), 'all')}
                        className="p-4 rounded-2xl border border-slate-200 hover:bg-slate-50 transition-all group"
                        title="Copy JSON"
                      >
                         <i className={`fas ${copyStatus === 'all' ? 'fa-check text-emerald-500' : 'fa-code text-slate-400 group-hover:text-slate-600'}`}></i>
                      </button>
                      <button className="px-8 py-4 bg-indigo-600 text-white rounded-2xl text-[11px] font-black uppercase tracking-widest shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95">
                        Deploy Ticket
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
                    {/* Rationale */}
                    <div className="space-y-4">
                      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center">
                        <i className="fas fa-brain mr-2 text-indigo-400"></i> Analysis Rationale
                      </h4>
                      <div className="p-6 bg-slate-50 rounded-3xl border border-slate-100 min-h-[100px] flex items-center">
                         <p className="text-slate-700 text-[15px] font-semibold leading-relaxed">{result.priority_reason}</p>
                      </div>
                    </div>
                    {/* Troubleshooting */}
                    <div className="space-y-4">
                      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center">
                        <i className="fas fa-wrench mr-2 text-emerald-400"></i> Next Step
                      </h4>
                      <div className="p-6 bg-emerald-50/40 rounded-3xl border border-emerald-100 min-h-[100px] flex items-center">
                         <p className="text-emerald-950 text-[15px] font-black leading-relaxed">{result.troubleshooting_step}</p>
                      </div>
                    </div>
                  </div>

                  {/* Grounding Sources */}
                  {result.grounding_sources && result.grounding_sources.length > 0 && (
                    <div className="mb-12 space-y-4">
                      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center">
                        <i className="fas fa-search-nodes mr-2 text-indigo-400"></i> External Context & Outages
                      </h4>
                      <div className="flex flex-wrap gap-3">
                        {result.grounding_sources.map((s, i) => (
                          <a 
                            key={i} 
                            href={s.uri} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center space-x-2 px-4 py-2 bg-indigo-50 text-indigo-600 rounded-xl border border-indigo-100 hover:bg-indigo-100 transition-all text-xs font-bold"
                          >
                            <i className="fas fa-link text-[10px]"></i>
                            <span>{s.title}</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Suggested Reply */}
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center">
                        <i className="fas fa-comment-dots mr-2 text-indigo-400"></i> Suggested Agent Reply
                      </h4>
                      <button 
                        onClick={() => copyToClipboard(result.reply, 'reply')}
                        className="text-[9px] font-black text-indigo-600 uppercase hover:underline"
                      >
                        {copyStatus === 'reply' ? 'Copied' : 'Copy Text'}
                      </button>
                    </div>
                    <div className="p-8 bg-white border-2 border-slate-100 rounded-3xl shadow-sm italic text-xl font-medium text-slate-600 leading-relaxed">
                       "{result.reply}"
                    </div>
                  </div>

                  {/* High Priority Escalation */}
                  {result.priority === Priority.High && result.escalation_instructions && (
                    <div className="mt-12 bg-rose-50 border-2 border-rose-100 border-dashed rounded-[32px] p-8 flex flex-col md:flex-row items-center gap-6">
                      <div className="w-14 h-14 bg-rose-600 rounded-2xl flex items-center justify-center shadow-lg shadow-rose-200">
                        <i className="fas fa-shield-halved text-white text-xl"></i>
                      </div>
                      <div className="flex-1 text-center md:text-left">
                        <h5 className="text-[10px] font-black text-rose-900 uppercase tracking-widest">Escalation Protocol Triggered</h5>
                        <p className="text-rose-800 font-bold text-lg mt-1">{result.escalation_instructions}</p>
                      </div>
                      <button className="px-6 py-3 bg-rose-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-rose-700 transition-all">
                        Execute Escalation
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Context Footer */}
              <div className="flex items-center justify-between px-4">
                <div className="flex items-center gap-6">
                  <div>
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Account Tier</span>
                    <span className="text-sm font-bold text-slate-700">{result.input.account_tier}</span>
                  </div>
                  <div className="w-[1px] h-8 bg-slate-200"></div>
                  <div>
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Recent Activity</span>
                    <span className="text-sm font-bold text-slate-700">{result.input.recent_activity_summary || 'Baseline activity'}</span>
                  </div>
                </div>
                <button className="text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-indigo-600 transition-colors">
                  View Full History <i className="fas fa-chevron-right ml-1"></i>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 bg-white rounded-[40px] border-2 border-dashed border-slate-100 p-12 flex flex-col items-center justify-center text-center space-y-6">
               <div className="w-24 h-24 bg-slate-50 rounded-[32px] flex items-center justify-center border border-slate-100">
                  <i className="fas fa-ticket-alt text-4xl text-slate-200"></i>
               </div>
               <div className="space-y-2">
                 <h3 className="text-2xl font-black text-slate-900 tracking-tight">Terminal Idle</h3>
                 <p className="text-sm text-slate-400 font-medium max-w-xs mx-auto">
                    Awaiting input. Paste a customer message or start a live voice intake session to begin triage.
                 </p>
               </div>
               <div className="flex gap-4">
                 <button onClick={startLiveTriage} className="px-6 py-3 bg-indigo-50 text-indigo-600 rounded-xl text-[10px] font-black uppercase tracking-widest border border-indigo-100 hover:bg-indigo-100">Voice Intake</button>
                 <button onClick={() => setInput({...input, customer_message: "Paste example text here..."})} className="px-6 py-3 bg-slate-50 text-slate-600 rounded-xl text-[10px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-100">Paste Text</button>
               </div>
            </div>
          )}
        </div>
      </main>

      {/* Status Bar */}
      <footer className="bg-white border-t border-slate-100 px-8 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-6">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em]">HelpFlow Core v2.4.0</span>
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
            <i className="fas fa-shield-check mr-2 text-emerald-400"></i> SOC2 Compliant
          </span>
        </div>
        <div className="flex items-center space-x-6">
           <a href="#" className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] hover:text-indigo-600 transition-colors">Documentation</a>
           <a href="#" className="text-[9px] font-black text-slate-400 uppercase tracking-[0.2em] hover:text-indigo-600 transition-colors">API Keys</a>
        </div>
      </footer>
    </div>
  );
};

export default App;
