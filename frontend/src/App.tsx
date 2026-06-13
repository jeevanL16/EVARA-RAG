import { useState, useRef, useCallback, useEffect } from "react";
import {
  Shield, FileText, Upload, Trash2, Send, ChevronRight,
  AlertTriangle, Layers, RefreshCw, X, HelpCircle, Terminal, FileSpreadsheet, Coins
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useDropzone } from "react-dropzone";
import axios from "axios";

const API = "http://localhost:8000/api";

type Mode = "normal" | "security";

interface Doc {
  doc_id: string;
  filename: string;
  chunks: number;
  pages: number;
  indexed_at: string;
}

interface Citation {
  filename: string;
  page_number: number;
  score: number;
  text: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  warnings?: string[];
  source?: string;
  latency_ms?: number;
  loading?: boolean;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("normal");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const [health, setHealth] = useState<any>(null);
  
  // RAG Workspace tabs
  const [activeTab, setActiveTab] = useState<"chat" | "report" | "logs">("chat");
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null);
  
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [credits, setCredits] = useState<number>(() => {
    const saved = localStorage.getItem("evara_credits");
    return saved !== null ? parseFloat(saved) : 10.00;
  });
  const [tokens, setTokens] = useState<number>(() => {
    const saved = localStorage.getItem("evara_tokens");
    return saved !== null ? parseInt(saved, 10) : 0;
  });

  useEffect(() => {
    localStorage.setItem("evara_credits", credits.toFixed(6));
  }, [credits]);

  useEffect(() => {
    localStorage.setItem("evara_tokens", tokens.toString());
  }, [tokens]);

  const recordUsage = (queryText: string, contextChunks: any[], responseText: string) => {
    const inputChars = (queryText || "").length + (contextChunks || []).reduce((acc, c) => acc + (c.text || "").length, 0);
    const outputChars = (responseText || "").length;
    
    const inputTokens = Math.ceil(inputChars / 4);
    const outputTokens = Math.ceil(outputChars / 4);
    const sessionTokens = inputTokens + outputTokens;
    
    // Cost calculation (Llama 3.3 70B: $0.59/M input, $0.79/M output)
    const sessionCost = (inputTokens * 0.59 / 1000000) + (outputTokens * 0.79 / 1000000);
    
    setTokens(prev => prev + sessionTokens);
    setCredits(prev => Math.max(0, prev - sessionCost));
  };

  const resetCredits = () => {
    setCredits(10.00);
    setTokens(0);
    addSystemMessage("API Credit ledger successfully reset to default balance ($10.00).");
  };

  // Fetch docs + health on mount / mode change
  useEffect(() => {
    fetchDocs();
    fetchHealth();
    setSelectedCitation(null);
  }, [mode]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeTab]);

  async function fetchDocs() {
    try {
      const r = await axios.get(`${API}/documents?mode=${mode}`);
      setDocs(r.data);
    } catch {}
  }

  async function fetchHealth() {
    try {
      const r = await axios.get(`${API}/health`);
      setHealth(r.data);
    } catch {}
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  const onDrop = useCallback(async (files: File[]) => {
    setUploading(true);
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      form.append("mode", mode);
      try {
        const r = await axios.post(`${API}/upload`, form);
        const { doc_id, status, chunks, pages } = r.data;
        if (status === "indexed") {
          addSystemMessage(`Loaded indices for **${file.name}** successfully (${chunks} chunks, ${pages} pages).`);
          await fetchDocs();
          autoAnalyze(doc_id, file.name);
        } else if (status === "unchanged") {
          addSystemMessage(`Document **${file.name}** already verified in database (unchanged).`);
        }
      } catch (e: any) {
        addSystemMessage(`Index compilation failed for **${file.name}**: ${e.response?.data?.detail || e.message}`);
      }
    }
    setUploading(false);
  }, [mode]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, multiple: true });

  async function autoAnalyze(docId: string, filename: string) {
    setActiveTab("report");
    // Create assistant message explicitly tagged with "auto-analyzer" source so it renders in Reports tab immediately
    const msgId = addAssistantMessage("", true);
    updateMessage(msgId, { source: "auto-analyzer" });
    
    try {
      const r = await axios.post(`${API}/auto-analyze?doc_id=${docId}&mode=${mode}`);
      updateMessage(msgId, {
        content: r.data.answer,
        citations: r.data.citations,
        warnings: r.data.warnings,
        source: "auto-analyzer", // Lock to "auto-analyzer" to filter into reportMessages
        latency_ms: r.data.latency_ms,
        loading: false,
      });
      recordUsage("Provide a complete analysis of this document", r.data.citations || [], r.data.answer);
    } catch (e: any) {
      updateMessage(msgId, { 
        content: `Auto-analysis failed: ${e.message}`, 
        source: "auto-analyzer",
        loading: false 
      });
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────────────

  async function sendQuery() {
    const q = query.trim();
    if (!q || docs.length === 0) return;
    setQuery("");
    setActiveTab("chat");

    setMessages(prev => [...prev, { id: Date.now().toString(), role: "user", content: q }]);
    const msgId = addAssistantMessage("", true);

    try {
      const r = await axios.post(`${API}/query`, { query: q, mode });
      updateMessage(msgId, {
        content: r.data.answer,
        citations: r.data.citations,
        warnings: r.data.warnings,
        source: r.data.source,
        latency_ms: r.data.latency_ms,
        loading: false,
      });
      recordUsage(q, r.data.citations || [], r.data.answer);
    } catch (e: any) {
      updateMessage(msgId, { content: `Error: ${e.response?.data?.detail || e.message}`, loading: false });
    }
  }

  async function sendQueryWithText(text: string) {
    if (!text.trim() || docs.length === 0) return;
    setActiveTab("chat");
    setMessages(prev => [...prev, { id: Date.now().toString(), role: "user", content: text }]);
    const msgId = addAssistantMessage("", true);

    try {
      const r = await axios.post(`${API}/query`, { query: text, mode });
      updateMessage(msgId, {
        content: r.data.answer,
        citations: r.data.citations,
        warnings: r.data.warnings,
        source: r.data.source,
        latency_ms: r.data.latency_ms,
        loading: false,
      });
      recordUsage(text, r.data.citations || [], r.data.answer);
    } catch (e: any) {
      updateMessage(msgId, { content: `Error: ${e.response?.data?.detail || e.message}`, loading: false });
    }
  }

  function addSystemMessage(content: string) {
    setMessages(prev => [...prev, { id: Date.now().toString(), role: "assistant", content, source: "system" }]);
  }

  function addAssistantMessage(content: string, loading = false): string {
    const id = Date.now().toString();
    setMessages(prev => [...prev, { id, role: "assistant", content, loading }]);
    return id;
  }

  // Helper function to update messages
  function updateMessage(id: string, patch: Partial<Message>) {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  }

  async function deleteDoc(docId: string) {
    await axios.delete(`${API}/documents/${docId}?mode=${mode}`);
    setDocs(prev => prev.filter(d => d.doc_id !== docId));
    addSystemMessage("Document segment successfully de-indexed.");
    fetchHealth();
  }

  const getFileExtension = (filename: string) => {
    const parts = filename.split(".");
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : "DOC";
  };

  const getExtensionClass = (ext: string) => {
    switch (ext) {
      case "PDF":
        return "bg-red-50 text-red-600 border border-red-200/60";
      case "CSV":
        return "bg-emerald-50 text-emerald-600 border border-emerald-200/60";
      case "JSON":
        return "bg-amber-50 text-amber-600 border border-amber-200/60";
      case "ZIP":
        return "bg-blue-50 text-blue-600 border border-blue-200/60";
      default:
        return "bg-neutral-100 text-neutral-600 border border-neutral-200";
    }
  };

  // ── Render Configuration ───────────────────────────────────────────────────

  const isSecure = mode === "security";
  const accentCls = isSecure
    ? {
        btn: "bg-emerald-600 hover:bg-emerald-500 hover:shadow-md text-white font-bold transition-all duration-200",
        text: "text-emerald-600",
        border: "border-emerald-200",
        borderFocus: "focus-within:border-emerald-550 focus-within:ring-2 focus-within:ring-emerald-550/20",
        bg: "bg-emerald-50/50",
        badge: "bg-emerald-50 text-emerald-700 border border-emerald-200",
        sidebar: "bg-zinc-50 border-zinc-200/80",
        main: "bg-[#ffffff]",
        card: "bg-white border-zinc-200/85 hover:border-zinc-300 hover:shadow-md hover:-translate-y-[1px]",
        prose: "prose-emerald",
        led: "bg-emerald-500",
        tabs: "border-emerald-500"
      }
    : {
        btn: "bg-blue-600 hover:bg-blue-550 hover:shadow-md text-white font-bold transition-all duration-200",
        text: "text-blue-600",
        border: "border-blue-200",
        borderFocus: "focus-within:border-blue-550 focus-within:ring-2 focus-within:ring-blue-550/20",
        bg: "bg-blue-50/50",
        badge: "bg-blue-50 text-blue-700 border border-blue-200",
        sidebar: "bg-neutral-50 border-neutral-200/80",
        main: "bg-[#ffffff]",
        card: "bg-white border-neutral-200/85 hover:border-neutral-300 hover:shadow-md hover:-translate-y-[1px]",
        prose: "prose-amber",
        led: "bg-blue-500",
        tabs: "border-blue-600"
      };

  // ── Tab Filters ────────────────────────────────────────────────────────────

  const systemLogs = messages.filter(m => m.source === "system");
  const chatMessages = messages.filter(m => m.source !== "system" && m.source !== "auto-analyzer");
  const reportMessages = messages.filter(m => m.source === "auto-analyzer");

  // ── Prompt Templates ───────────────────────────────────────────────────────

  const promptTemplates = isSecure
    ? [
        { label: "Analyze vulnerability severity distribution", text: "Identify and summarize the highest severity vulnerabilities, CVE ratings, and recommended actions across the indexed records." },
        { label: "Check open ports & network exposure", text: "Provide a detailed summary of all identified open ports, exposed services, and network risk levels shown in the indexed documents." },
        { label: "Compile compliance & patching priority", text: "Review the indexed logs and generate a prioritized patching plan based on system compliance gaps and severity levels." }
      ]
    : [
        { label: "Summarize main findings", text: "Analyze the indexed files and generate a structured overview of the core findings, key metrics, and insights." },
        { label: "Perform comparative review", text: "Compare the contents and data structures across all indexed documents, detailing key differences and commonalities." },
        { label: "Extract timelines & indexes", text: "Create a detailed timeline of events, dates, and indexed markers found in the uploaded records." }
      ];

  return (
    <div className={`flex h-screen overflow-hidden font-sans transition-all duration-300 ${accentCls.main} text-neutral-800 text-sm`}>
      
      {/* ── Panel 1: Sidebar (Library & Settings) ── */}
      <aside className={`w-[340px] flex flex-col border-r select-none transition-all duration-300 ${accentCls.sidebar}`}>
        
        {/* Workspace Brand / Header */}
        <div className="p-4.5 border-b border-neutral-200">
          <div className="flex items-center gap-3.5 mb-4.5">
            <div className={`p-3 rounded bg-white border border-neutral-200 shadow-sm transition-transform duration-200 hover:rotate-6`}>
              <Layers className={`w-6 h-6 ${accentCls.text}`} />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-sm font-mono tracking-widest text-neutral-800">EVARA</span>
                <span className={`text-[9px] font-bold font-mono px-1.5 py-0.2 rounded transition-all duration-300 ${accentCls.badge}`}>V3.0</span>
              </div>
              <p className="text-[10px] font-mono text-neutral-450 uppercase tracking-tighter">Enterprise RAG Engine</p>
            </div>
          </div>

          {/* Segmented Controller for Mode Switcher */}
          <div className="relative flex p-0.5 bg-neutral-200/60 rounded-md border border-neutral-300/40">
            <div
              className={`absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded transition-transform duration-300 ease-out bg-white shadow border border-neutral-200/60 ${
                mode === "security" ? "translate-x-full" : "translate-x-0"
              }`}
            />
            <button
              onClick={() => setMode("normal")}
              className={`relative z-10 flex-1 py-2 px-2.5 rounded text-xs font-bold font-mono tracking-tight transition-colors duration-200 flex items-center justify-center gap-2 ${
                mode === "normal" ? "text-neutral-900" : "text-neutral-500 hover:text-neutral-700"
              }`}
            >
              <FileText className="w-5 h-5" />
              NORMAL
            </button>
            <button
              onClick={() => setMode("security")}
              className={`relative z-10 flex-1 py-2 px-2.5 rounded text-xs font-bold font-mono tracking-tight transition-colors duration-200 flex items-center justify-center gap-2 ${
                mode === "security" ? "text-neutral-900" : "text-neutral-500 hover:text-neutral-700"
              }`}
            >
              <Shield className="w-5 h-5" />
              SECURITY
            </button>
          </div>
        </div>

        {/* Upload Action Panel */}
        <div className="p-5 border-b border-neutral-200/80">
          <div
            {...getRootProps()}
            className={`border border-dashed rounded-lg p-5.5 text-center cursor-pointer transition-all duration-300 bg-white shadow-sm hover:shadow-md hover:border-neutral-450
              ${isDragActive ? `border-neutral-450 bg-neutral-50 scale-[0.97]` : "border-neutral-300"}
              ${uploading ? "opacity-50 pointer-events-none" : ""}`}
          >
            <input {...getInputProps()} />
            <Upload className={`w-6 h-6 mx-auto mb-2 text-neutral-450 transition-transform duration-300 hover:-translate-y-0.5`} />
            {uploading ? (
              <p className="text-[10px] font-mono text-neutral-450 animate-pulse tracking-wide font-bold">COMPILING SEGMENTS...</p>
            ) : (
              <p className="text-[10px] font-mono text-neutral-450 tracking-wide font-medium">
                {isDragActive ? "DROP ARCHIVE HERE" : "DRAG FILES OR CLICK TO INDEX"}
              </p>
            )}
          </div>
        </div>

        {/* Document Tree Hierarchy */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="flex items-center justify-between px-1 mb-2">
            <span className="text-[10px] font-mono font-bold text-neutral-450 tracking-wider">INDEXED_RECORDS ({docs.length})</span>
          </div>
          
          {docs.length === 0 ? (
            <div className="border border-neutral-200/60 bg-white/40 rounded p-4 text-center shadow-inner">
              <p className="text-xs font-mono text-neutral-400 italic">No verified records present in mode: {mode}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {docs.map(doc => {
                const ext = getFileExtension(doc.filename);
                const extCls = getExtensionClass(ext);
                return (
                  <div
                    key={doc.doc_id}
                    className="group flex items-center justify-between py-3.5 px-4 rounded-lg bg-white hover:bg-neutral-50/50 border border-neutral-200/50 hover:border-neutral-300 shadow-sm transition-all duration-200 hover:-translate-y-[0.5px]"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`text-[10px] font-mono font-extrabold px-2.5 py-0.5 rounded leading-none ${extCls}`}>
                        {ext}
                      </span>
                      <span className="text-xs text-neutral-750 truncate select-all font-medium tracking-tight" title={doc.filename}>
                        {doc.filename}
                      </span>
                    </div>
                    
                    <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                      <span className="text-[10px] text-neutral-400 font-mono">
                        {doc.chunks}ch
                      </span>
                      <button
                        onClick={() => deleteDoc(doc.doc_id)}
                        className="p-1 text-neutral-450 hover:text-red-500 rounded hover:bg-neutral-100/50 transition-all duration-150"
                        title="De-index Record"
                      >
                        <Trash2 className="w-4.5 h-4.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Token & API Credit Ledger */}
        <div className="p-5 border-t border-neutral-200/80 bg-neutral-50/45 font-mono text-[10px]">
          <div className="flex items-center justify-between mb-2.5 pb-1 border-b border-neutral-200">
            <div className="flex items-center gap-1.5 font-bold text-neutral-550 uppercase tracking-wider">
              <Coins className={`w-4 h-4 ${accentCls.text}`} />
              API_CREDIT_LEDGER
            </div>
            <button
              onClick={resetCredits}
              className="text-neutral-450 hover:text-red-500 font-bold tracking-tighter"
              title="Reset Ledger Balance"
            >
              RESET
            </button>
          </div>
          
          <div className="grid grid-cols-2 gap-2 text-neutral-500">
            <div className="bg-white p-2.5 rounded border border-neutral-200 shadow-sm transition-all duration-200 hover:-translate-y-[0.5px]">
              <span className="block text-neutral-450 text-[8.5px] uppercase font-bold tracking-tight">TOKENS_SPENT</span>
              <span className="text-sm text-neutral-750 font-bold font-mono">{tokens.toLocaleString()}</span>
            </div>
            <div className="bg-white p-2.5 rounded border border-neutral-200 shadow-sm transition-all duration-200 hover:-translate-y-[0.5px]">
              <span className="block text-neutral-450 text-[8.5px] uppercase font-bold tracking-tight">BUDGET_REMAINING</span>
              <span className={`text-sm font-bold font-mono ${credits < 1.00 ? 'text-red-500 animate-pulse' : 'text-neutral-750'}`}>
                ${credits.toFixed(5)}
              </span>
            </div>
          </div>
        </div>

        {/* System Co-Processor Metrics / Health */}
        {health && (
          <div className="p-5 border-t border-neutral-200/80 bg-neutral-50/45 font-mono text-[10px]">
            <div className="flex items-center justify-between mb-2.5 pb-1 border-b border-neutral-200">
              <div className="flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="text-neutral-550 font-bold uppercase tracking-wider">SYSTEM_STATUS</span>
              </div>
              <button
                onClick={fetchHealth}
                className="text-neutral-450 hover:text-neutral-650 hover:rotate-180 transition-all duration-300"
                title="Force Stats Reload"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
            
            <div className="grid grid-cols-2 gap-2 text-neutral-500">
              <div className="bg-white p-2.5 rounded border border-neutral-200 shadow-sm transition-all duration-200 hover:-translate-y-[0.5px]">
                <span className="block text-neutral-450 text-[8.5px] uppercase font-bold tracking-tight">NORM_CHUNKS</span>
                <span className="text-sm text-neutral-750 font-bold font-mono">{health.normal_chunks}</span>
              </div>
              <div className="bg-white p-2.5 rounded border border-neutral-200 shadow-sm transition-all duration-200 hover:-translate-y-[0.5px]">
                <span className="block text-neutral-450 text-[8.5px] uppercase font-bold tracking-tight">SEC_CHUNKS</span>
                <span className="text-sm text-neutral-750 font-bold font-mono">{health.security_chunks}</span>
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* ── Panel 2: Center (Primary Workspace & Tabs) ── */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-white">
        
        {/* Workspace Action Header Bar */}
        <header className="px-8 border-b border-neutral-200 flex flex-col select-none bg-white">
          <div className="py-5.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${accentCls.led} animate-pulse`} />
              <h2 className="text-sm font-mono font-bold tracking-wider uppercase text-neutral-750">
                {isSecure ? "SECURITY_ANALYSIS_WORKSPACE" : "DOCUMENT_ANALYSIS_WORKSPACE"}
              </h2>
            </div>
            <span className={`text-xs font-mono font-bold px-3 py-0.5 rounded transition-all duration-300 ${accentCls.badge}`}>
              {isSecure ? "SEC_COPILOT_MODE" : "STANDARD_RAG_MODE"}
            </span>
          </div>

          {/* RAG Workspace tab heads */}
          <div className="flex items-center gap-9 border-t border-neutral-100 text-sm font-mono font-bold tracking-wide text-neutral-450">
            <button
              onClick={() => setActiveTab("chat")}
              className={`py-4 border-b-2 transition-all duration-250 flex items-center gap-2.5 ${
                activeTab === "chat"
                  ? `${accentCls.tabs} text-neutral-800`
                  : "border-transparent hover:text-neutral-600"
              }`}
            >
              <HelpCircle className="w-5 h-5" />
              CHAT_ASSISTANT ({chatMessages.length})
            </button>
            
            <button
              onClick={() => setActiveTab("report")}
              className={`py-3.5 border-b-2 transition-all duration-250 flex items-center gap-2 ${
                activeTab === "report"
                  ? `${accentCls.tabs} text-neutral-800`
                  : "border-transparent hover:text-neutral-600"
              }`}
            >
              <FileSpreadsheet className="w-5 h-5" />
              INDEX_REPORTS ({reportMessages.length})
            </button>
            
            <button
              onClick={() => setActiveTab("logs")}
              className={`py-3.5 border-b-2 transition-all duration-250 flex items-center gap-2 ${
                activeTab === "logs"
                  ? `${accentCls.tabs} text-neutral-800`
                  : "border-transparent hover:text-neutral-600"
              }`}
            >
              <Terminal className="w-5 h-5" />
              SYSTEM_LOGS ({systemLogs.length})
            </button>
          </div>
        </header>

        {/* Message Log Grid */}
        <div className="flex-1 overflow-y-auto px-10 pt-10 pb-[150px] space-y-8">
          
          {/* 1. CHAT ASSISTANT TAB VIEW */}
          {activeTab === "chat" && (
            chatMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-lg mx-auto space-y-6 select-none animate-fade-in-up">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold tracking-wider text-neutral-805 uppercase font-mono">
                    COPROCESSOR CHAT INTERFACE
                  </h3>
                  <p className="text-xs text-neutral-500 leading-relaxed font-sans">
                    Ask targeted questions grounded in the indexed database files. Click a prompt blueprint below to get started:
                  </p>
                </div>
                
                {/* Prompt Blueprint Action Chips */}
                <div className="grid grid-cols-1 gap-3 w-full text-left">
                  {promptTemplates.map((template, idx) => (
                    <button
                      key={idx}
                      onClick={() => sendQueryWithText(template.text)}
                      disabled={docs.length === 0}
                      className="group flex items-start gap-3 p-4 rounded-lg border border-neutral-200 bg-white hover:bg-neutral-50/50 hover:border-neutral-300 text-xs shadow-sm hover:shadow transition-all duration-200 hover:-translate-y-[1px] disabled:opacity-45"
                    >
                      <ChevronRight className={`w-5 h-5 shrink-0 mt-0.5 ${accentCls.text} group-hover:translate-x-1 transition-transform duration-200`} />
                      <div className="text-left font-sans">
                        <p className="font-semibold text-neutral-800 transition-colors group-hover:text-neutral-950 text-xs">{template.label}</p>
                        <p className="text-neutral-500 text-[11px] leading-relaxed mt-1">{template.text}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-8 max-w-4xl mx-auto">
                {chatMessages.map(msg => (
                  <div key={msg.id} className="space-y-3.5 animate-fade-in-up">
                    
                    {/* User Question */}
                    {msg.role === "user" ? (
                      <div className="flex gap-3 items-start py-4 border-l-4 border-neutral-400 bg-neutral-50 px-6 text-sm text-neutral-750 rounded-lg shadow-sm border-r border-t border-b border-neutral-200/60 hover:shadow transition-shadow duration-200">
                        <span className="text-neutral-400 font-bold shrink-0 select-none">&gt;</span>
                        <span className="flex-1 break-words font-sans text-neutral-900 leading-relaxed font-semibold">{msg.content}</span>
                      </div>
                    ) : (
                      
                      /* Coprocessor Answer */
                      <div className={`group border ${accentCls.card} rounded-xl p-7 transition-all duration-300 shadow-sm`}>
                        
                        <div className="flex items-center justify-between mb-3.5 pb-2.5 border-b border-neutral-100">
                          <div className="flex items-center gap-2">
                            <span className={`w-1.5 h-1.5 rounded-full ${accentCls.led}`} />
                            <span className="text-[9px] font-mono tracking-wider font-extrabold text-neutral-500 uppercase">
                              {isSecure ? "SECURITY_COPILOT" : "DOCUMENT_ANALYSIS"}
                            </span>
                          </div>
                          
                          {!msg.loading && msg.latency_ms && (
                            <span className="text-[9px] font-mono text-neutral-400 uppercase tracking-tighter">
                              LATENCY: {msg.latency_ms}ms
                            </span>
                          )}
                        </div>

                        {/* Fenced component mapping for clean tables, block code, inline code and lists */}
                        {msg.loading ? (
                          <div className="space-y-3 py-1 select-none">
                            <div className="h-4 shimmer-bg rounded w-1/4" />
                            <div className="h-4 shimmer-bg rounded w-full" />
                            <div className="h-4 shimmer-bg rounded w-5/6" />
                          </div>
                        ) : (
                          <div className={`prose ${accentCls.prose} max-w-none text-sm leading-relaxed text-neutral-805 font-sans`}>
                            <ReactMarkdown
                              components={{
                                h1: ({node, ...props}) => <h1 className="text-base font-bold text-neutral-900 mt-4 mb-2 tracking-tight" {...props} />,
                                h2: ({node, ...props}) => <h2 className="text-sm font-semibold text-neutral-900 mt-3 mb-2 tracking-tight" {...props} />,
                                h3: ({node, ...props}) => <h3 className="text-xs font-semibold text-neutral-800 mt-2 mb-1" {...props} />,
                                p: ({node, ...props}) => <p className="text-sm text-neutral-700 leading-relaxed mb-2.5" {...props} />,
                                ul: ({node, ...props}) => <ul className="list-disc pl-5 text-sm text-neutral-700 space-y-1 mb-3" {...props} />,
                                ol: ({node, ...props}) => <ol className="list-decimal pl-5 text-sm text-neutral-700 space-y-1 mb-3" {...props} />,
                                li: ({node, ...props}) => <li className="pl-0.5 text-sm" {...props} />,
                                blockquote: ({node, ...props}) => <blockquote className="border-l-2 border-neutral-350 bg-neutral-50/50 pl-3.5 py-1.5 italic my-3 text-neutral-600 text-xs rounded" {...props} />,
                                a: ({node, ...props}) => <a className={`${accentCls.text} hover:underline font-semibold`} target="_blank" rel="noopener noreferrer" {...props} />,
                                table: ({node, ...props}) => (
                                  <div className="overflow-x-auto my-3 border border-neutral-200 rounded-md">
                                    <table className="min-w-full divide-y divide-neutral-200 text-xs text-left" {...props} />
                                  </div>
                                ),
                                thead: ({node, ...props}) => <thead className="bg-neutral-50 text-[10px] font-mono font-bold text-neutral-550 uppercase tracking-wider" {...props} />,
                                th: ({node, ...props}) => <th className="px-3.5 py-2.5 border-b border-neutral-200" {...props} />,
                                td: ({node, ...props}) => <td className="px-3.5 py-2 border-b border-neutral-100 text-neutral-650 font-sans" {...props} />,
                                tr: ({node, ...props}) => <tr className="hover:bg-neutral-50/40 transition-colors" {...props} />,
                                pre: ({node, ...props}) => <pre className="bg-neutral-50 border border-neutral-200 rounded-md p-3.5 my-3.5 overflow-x-auto font-mono text-xs text-neutral-800 leading-relaxed" {...props} />,
                                code: ({node, ...props}) => <code className="bg-neutral-50 border border-neutral-200/80 px-2 py-0.5 rounded font-mono text-xs text-neutral-700 font-semibold" {...props} />
                              }}
                            >
                              {msg.content}
                            </ReactMarkdown>
                          </div>
                        )}

                        {/* System Warnings Block */}
                        {msg.warnings && msg.warnings.length > 0 && (
                          <div className="mt-4 space-y-1.5">
                            {msg.warnings.map((w, i) => (
                              <div key={i} className="flex gap-2 items-start text-xs text-amber-800 bg-amber-50 border border-amber-200/80 rounded p-2.5 font-mono shadow-sm">
                                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-600" />
                                <span className="leading-tight">WARNING: {w}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Monospace Interactive References Tag list */}
                        {!msg.loading && msg.citations && msg.citations.length > 0 && (
                          <div className="mt-4.5 pt-3 border-t border-neutral-100 flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] font-mono text-neutral-450 font-bold uppercase mr-1">References:</span>
                            {msg.citations.map((c, idx) => (
                              <button
                                key={idx}
                                onClick={() => setSelectedCitation(c)}
                                className={`text-[10.5px] font-mono font-bold px-2.5 py-1 rounded border transition-all duration-200 ${
                                  selectedCitation === c
                                    ? `${isSecure ? "bg-emerald-600 text-white border-emerald-600 shadow-sm" : "bg-blue-600 text-white border-blue-600 shadow-sm"}`
                                    : "bg-neutral-50 hover:bg-neutral-100 text-neutral-500 border-neutral-200 hover:-translate-y-[0.5px]"
                                }`}
                              >
                                [{idx + 1}] {c.filename.substring(0, 18)}{c.filename.length > 18 && "..."}
                              </button>
                            ))}
                          </div>
                        )}

                      </div>
                    )}

                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            )
          )}

          {/* 2. INDEX REPORTS TAB VIEW */}
          {activeTab === "report" && (
            reportMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-sm mx-auto space-y-4 select-none animate-fade-in-up">
                <FileSpreadsheet className="w-14 h-14 text-neutral-350 mx-auto animate-pulse" />
                <h3 className="text-xs font-semibold text-neutral-700 tracking-wider font-mono">AWAITING COMPILER LOGS</h3>
                <p className="text-xs text-neutral-450 leading-relaxed font-sans">
                  Index a document or request an automatic record query summary to populate files here.
                </p>
              </div>
            ) : (
              <div className="space-y-8 max-w-4xl mx-auto">
                {reportMessages.map(msg => (
                  <div key={msg.id} className="border border-neutral-200/80 rounded-xl bg-white p-7 shadow-sm animate-fade-in-up hover:shadow-md hover:border-neutral-300 transition-all duration-300">
                    <div className="flex items-center justify-between mb-3.5 pb-2.5 border-b border-neutral-100">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${accentCls.led}`} />
                        <span className="text-[9px] font-mono tracking-wider font-extrabold text-neutral-550 uppercase">
                          INDEX_REPORT_SUMMARY
                        </span>
                      </div>
                      <span className="text-[9px] font-mono text-neutral-400">
                        LATENCY: {msg.latency_ms || "0"}ms
                      </span>
                    </div>

                    {msg.loading ? (
                      <div className="space-y-3 py-1 select-none">
                        <div className="h-4 shimmer-bg rounded w-1/4" />
                        <div className="h-4 shimmer-bg rounded w-full" />
                        <div className="h-4 shimmer-bg rounded w-5/6" />
                      </div>
                    ) : (
                      <div className={`prose ${accentCls.prose} max-w-none text-sm leading-relaxed text-neutral-800`}>
                        <ReactMarkdown
                          components={{
                            h1: ({node, ...props}) => <h1 className="text-base font-bold text-neutral-900 mt-4 mb-2" {...props} />,
                            h2: ({node, ...props}) => <h2 className="text-sm font-semibold text-neutral-900 mt-3 mb-2" {...props} />,
                            p: ({node, ...props}) => <p className="text-sm text-neutral-700 mb-2.5" {...props} />,
                            ul: ({node, ...props}) => <ul className="list-disc pl-5 text-sm text-neutral-700 mb-3" {...props} />,
                            table: ({node, ...props}) => (
                              <div className="overflow-x-auto my-3 border border-neutral-200 rounded-md">
                                <table className="min-w-full divide-y divide-neutral-200 text-xs text-left" {...props} />
                              </div>
                            ),
                            thead: ({node, ...props}) => <thead className="bg-neutral-50 text-[10px] font-mono uppercase text-neutral-500" {...props} />,
                            th: ({node, ...props}) => <th className="px-3.5 py-2 border-b border-neutral-200" {...props} />,
                            td: ({node, ...props}) => <td className="px-3.5 py-2 border-b border-neutral-100 text-neutral-650" {...props} />,
                            tr: ({node, ...props}) => <tr className="hover:bg-neutral-50/40" {...props} />
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {/* 3. SYSTEM LOGS TAB VIEW */}
          {activeTab === "logs" && (
            systemLogs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center max-w-sm mx-auto space-y-3.5 select-none animate-fade-in-up">
                <Terminal className="w-12 h-12 text-neutral-350 mx-auto" />
                <h3 className="text-xs font-semibold text-neutral-700 tracking-wider font-mono">NO LOGS CAPTURED</h3>
                <p className="text-xs text-neutral-450 leading-relaxed">
                  Indexing, deletions, database and latency metrics will capture here in real time.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 max-w-3xl mx-auto font-mono text-[11px] animate-fade-in-up">
                {systemLogs.map(msg => (
                  <div key={msg.id} className="flex gap-3 items-start py-2.5 border border-neutral-200/50 bg-neutral-50/50 px-4 rounded text-neutral-655 shadow-sm hover:border-neutral-300 transition-colors duration-150">
                    <span className="text-neutral-450 font-bold shrink-0 select-none">[SYS]</span>
                    <span className="flex-1 break-words leading-relaxed">{msg.content}</span>
                  </div>
                ))}
              </div>
            )
          )}

        </div>

        {/* unified command console bar input */}
        <div className="absolute bottom-8 left-8 right-8 max-w-4xl mx-auto z-20">
          <div className={`backdrop-blur-md bg-white/95 border border-neutral-200/80 ${accentCls.borderFocus} shadow-2xl rounded-2xl p-5.5 transition-all duration-300`}>
            
            <textarea
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendQuery();
                }
              }}
              placeholder={
                docs.length === 0
                  ? "SYSTEM STATE: Awaiting indexed documents to proceed..."
                  : isSecure
                  ? "Console query: ask about CVE targets, assets, scan metrics..."
                  : "Console query: ask questions, extract lists, compare indexes..."
              }
              disabled={docs.length === 0}
              rows={2}
              className="w-full bg-transparent resize-none text-sm leading-relaxed text-neutral-805 outline-none placeholder-neutral-400 disabled:opacity-30 font-mono"
            />
            
            <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-neutral-100 font-mono text-[10px] select-none font-bold">
              <div className="text-neutral-400">
                {docs.length > 0 ? (
                  <span className={`flex items-center gap-1.5 font-bold ${accentCls.text}`}>
                    <span className={`w-2 h-2 rounded-full ${accentCls.led} animate-pulse`} />
                    CO-PROCESSOR COGNITION ENGAGED
                  </span>
                ) : (
                  <span className="text-neutral-400 font-bold">CO-PROCESSOR STANDBY [INDEX RECORD REQUIRED]</span>
                )}
              </div>
              
              <div className="flex items-center gap-3">
                <span className="text-[9px] text-neutral-450 bg-neutral-50 px-2 py-0.5 rounded border border-neutral-200 font-extrabold uppercase">
                  ENTER ↵ TO EXEC
                </span>
                
                <button
                  onClick={sendQuery}
                  disabled={!query.trim() || docs.length === 0}
                  className={`p-2 rounded ${accentCls.btn} disabled:opacity-10 transition-all duration-150 shadow-sm`}
                  title="Execute Command"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>

          </div>
          <p className="text-[10px] font-mono text-neutral-450 mt-2.5 text-center uppercase tracking-tight font-bold">
            Deterministic answers compiled solely via internal index maps. Zero heuristics hallucinated.
          </p>
        </div>

      </main>

      {/* ── Panel 3: Citations Reference Inspector (Slides from Right) ── */}
      {selectedCitation && (
        <aside className="w-[420px] flex flex-col border-l border-neutral-200 bg-white select-none relative animate-slide-in-right shadow-2xl z-30 transition-all duration-350">
          
          {/* Inspector Header */}
          <div className="p-6 border-b border-neutral-200 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Layers className={`w-6 h-6 ${accentCls.text}`} />
              <span className="font-extrabold text-[10.5px] font-mono tracking-widest text-neutral-800">CITATION_REFERENCE</span>
            </div>
            <button
              onClick={() => setSelectedCitation(null)}
              className="p-1 rounded text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 transition-colors duration-200"
              title="Close Reference Panel"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          
          {/* Reference Info Card */}
          <div className="p-6 space-y-6 flex-1 overflow-y-auto">
            
            {/* Filename & Mode Match Metric */}
            <div className="bg-neutral-50 border border-neutral-200/80 rounded-lg p-5.5 font-mono text-xs text-neutral-750 shadow-sm transition-all duration-200">
              <span className="text-[9.5px] text-neutral-400 block mb-1.5 font-bold uppercase">Source Document:</span>
              <p className="font-bold text-neutral-900 truncate mb-3" title={selectedCitation.filename}>
                {selectedCitation.filename}
              </p>
              
              <div className="grid grid-cols-2 gap-3.5 pt-3.5 border-t border-neutral-200/60">
                <div>
                  <span className="text-[8.5px] text-neutral-400 block uppercase font-bold">PAGE_NUM</span>
                  <span className="text-xs text-neutral-805 font-bold">{selectedCitation.page_number}</span>
                </div>
                <div>
                  <span className="text-[8.5px] text-neutral-400 block uppercase font-bold">RELEVANCE</span>
                  <span className={`text-xs font-bold ${accentCls.text}`}>{(selectedCitation.score * 100).toFixed(0)}%</span>
                </div>
              </div>

              {/* Progress visual Relevance Score Bar */}
              <div className="w-full bg-neutral-200 rounded-full h-1 mt-3.5">
                <div
                  className={`h-1 rounded-full ${isSecure ? "bg-emerald-550" : "bg-blue-600"}`}
                  style={{ width: `${selectedCitation.score * 100}%` }}
                />
              </div>
            </div>

            {/* Citation exact Text Segment */}
            <div className="space-y-2">
              <span className="text-[9.5px] font-mono text-neutral-450 font-bold uppercase tracking-wider">Grounding Snippet:</span>
              <div className="border border-neutral-200/80 rounded-lg p-4 bg-neutral-50/20 text-xs text-neutral-600 font-sans italic leading-relaxed relative shadow-sm">
                <span className="text-2xl text-neutral-250 font-serif absolute top-1 left-2 pointer-events-none">“</span>
                <p className="pl-4 pr-2 pt-1 font-sans not-italic text-neutral-700 leading-relaxed text-sm">
                  {selectedCitation.text}
                </p>
                <span className="text-2xl text-neutral-250 font-serif absolute bottom-1 right-2 pointer-events-none">”</span>
              </div>
            </div>

          </div>

          {/* Citation Info Footer */}
          <div className="p-3 bg-neutral-50/50 border-t border-neutral-200 font-mono text-[10px] text-neutral-450">
            <span>Verified GROUNDED segment index match.</span>
          </div>

        </aside>
      )}

    </div>
  );
}
