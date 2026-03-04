export type Language = 'en' | 'hi' | 'es' | 'bn';

export interface LanguageMeta {
  code: Language;
  label: string;       // native name
  labelEn: string;     // english name
  flag: string;        // emoji flag
  dir: 'ltr' | 'rtl';
}

export const LANGUAGES: LanguageMeta[] = [
  { code: 'en', label: 'English',  labelEn: 'English',  flag: '🇬🇧', dir: 'ltr' },
  { code: 'hi', label: 'हिन्दी',    labelEn: 'Hindi',    flag: '🇮🇳', dir: 'ltr' },
  { code: 'es', label: 'Español',  labelEn: 'Spanish',  flag: '🇪🇸', dir: 'ltr' },
  { code: 'bn', label: 'বাংলা',    labelEn: 'Bengali',  flag: '🇧🇩', dir: 'ltr' },
];

export interface Translations {
  appSubtitle: string;
  uploadTitle: string;
  uploadTitleDrag: string;
  uploadSubtitle: string;
  uploadHint: string;
  analyzeBtn: (count: number) => string;
  analyzingBtn: string;
  submittingBtn: string;
  clearAll: string;
  statusConnecting: string;
  statusReady: string;
  statusNoModel: string;
  statusOffline: string;
  statusLoadModel: string;
  failedChecks: (count: number) => string;
  emptyAnalysis: string;
  analyzeAction: string;
  analysisError: string;
  analyzing: (name?: string) => string;
  thinkingHint: string;
  reasoning: string;
  tokens: string;
  summary: string;
  keyObservations: string;
  contentClassification: string;
  extractedText: string;
  mode: string;
  fast: string;
  slow: string;
  processedIn: (secs: string) => string;
  truncated: string;
  truncatedTooltip: string;
  noTextDetected: string;
  pdfPlaceholder: string;
  previewEmpty: string;
  languageLabel: string;
}

const en: Translations = {
  appSubtitle: 'Powered by Nvidia RTX 5090 · Blackwell Architecture',
  uploadTitle: 'Drag & drop files here',
  uploadTitleDrag: 'Drop files here',
  uploadSubtitle: 'or click to browse',
  uploadHint: 'JPEG, PNG, WebP, GIF, BMP, TIFF, PDF — up to 20 MB each',
  analyzeBtn: (n) => `Analyze ${n} file${n !== 1 ? 's' : ''}`,
  analyzingBtn: 'Analyzing...',
  submittingBtn: 'Submitting...',
  clearAll: 'Clear All',
  statusConnecting: 'Connecting...',
  statusReady: 'Model Ready',
  statusNoModel: 'No Model Loaded',
  statusOffline: 'Backend Offline',
  statusLoadModel: 'Load a model in LM Studio',
  failedChecks: (n) => `${n} failed checks`,
  emptyAnalysis: 'Upload a file and click Analyze to get AI-powered analysis',
  analyzeAction: 'Analyze',
  analysisError: 'Analysis Error',
  analyzing: (name) => name ? `Analyzing "${name}"...` : 'Analyzing...',
  thinkingHint: 'Model is thinking and reasoning...',
  reasoning: 'Model Reasoning',
  tokens: 'tokens',
  summary: 'Summary',
  keyObservations: 'Key Observations',
  contentClassification: 'Content Classification',
  extractedText: 'Extracted Text',
  mode: 'Mode',
  fast: 'Fast',
  slow: 'Slow',
  processedIn: (s) => `Processed in ${s}s`,
  truncated: 'Truncated',
  truncatedTooltip: 'Model hit token limit — reasoning or response may be truncated',
  noTextDetected: 'No text detected.',
  pdfPlaceholder: 'PDF',
  previewEmpty: 'No files uploaded',
  languageLabel: 'Language',
};

const hi: Translations = {
  appSubtitle: 'Powered by Nvidia RTX 5090 · Blackwell Architecture',
  uploadTitle: 'फ़ाइलें यहाँ खींचें और छोड़ें',
  uploadTitleDrag: 'फ़ाइलें यहाँ छोड़ें',
  uploadSubtitle: 'या ब्राउज़ करने के लिए क्लिक करें',
  uploadHint: 'JPEG, PNG, WebP, GIF, BMP, TIFF, PDF — प्रत्येक 20 MB तक',
  analyzeBtn: (n) => `${n} फ़ाइल${n !== 1 ? 'ों' : ''} का विश्लेषण करें`,
  analyzingBtn: 'विश्लेषण हो रहा है...',
  submittingBtn: 'जमा किया जा रहा है...',
  clearAll: 'सब हटाएँ',
  statusConnecting: 'कनेक्ट हो रहा है...',
  statusReady: 'मॉडल तैयार',
  statusNoModel: 'कोई मॉडल लोड नहीं',
  statusOffline: 'बैकएंड ऑफ़लाइन',
  statusLoadModel: 'LM Studio में एक मॉडल लोड करें',
  failedChecks: (n) => `${n} विफल जाँच`,
  emptyAnalysis: 'AI-संचालित विश्लेषण प्राप्त करने के लिए एक फ़ाइल अपलोड करें और विश्लेषण करें पर क्लिक करें',
  analyzeAction: 'विश्लेषण करें',
  analysisError: 'विश्लेषण त्रुटि',
  analyzing: (name) => name ? `"${name}" का विश्लेषण हो रहा है...` : 'विश्लेषण हो रहा है...',
  thinkingHint: 'मॉडल सोच रहा है और तर्क कर रहा है...',
  reasoning: 'मॉडल तर्क',
  tokens: 'टोकन',
  summary: 'सारांश',
  keyObservations: 'मुख्य अवलोकन',
  contentClassification: 'सामग्री वर्गीकरण',
  extractedText: 'निकाला गया पाठ',
  mode: 'मोड',
  fast: 'तेज़',
  slow: 'धीमा',
  processedIn: (s) => `${s} सेकंड में संसाधित`,
  truncated: 'काट दिया गया',
  truncatedTooltip: 'मॉडल ने टोकन सीमा पार कर ली — तर्क या प्रतिक्रिया काटी जा सकती है',
  noTextDetected: 'कोई पाठ नहीं मिला।',
  pdfPlaceholder: 'PDF',
  previewEmpty: 'कोई फ़ाइल अपलोड नहीं हुई',
  languageLabel: 'भाषा',
};

const es: Translations = {
  appSubtitle: 'Powered by Nvidia RTX 5090 · Blackwell Architecture',
  uploadTitle: 'Arrastra y suelta archivos aquí',
  uploadTitleDrag: 'Suelta los archivos aquí',
  uploadSubtitle: 'o haz clic para buscar',
  uploadHint: 'JPEG, PNG, WebP, GIF, BMP, TIFF, PDF — hasta 20 MB cada uno',
  analyzeBtn: (n) => `Analizar ${n} archivo${n !== 1 ? 's' : ''}`,
  analyzingBtn: 'Analizando...',
  submittingBtn: 'Enviando...',
  clearAll: 'Borrar todo',
  statusConnecting: 'Conectando...',
  statusReady: 'Modelo listo',
  statusNoModel: 'Ningún modelo cargado',
  statusOffline: 'Backend sin conexión',
  statusLoadModel: 'Carga un modelo en LM Studio',
  failedChecks: (n) => `${n} verificaciones fallidas`,
  emptyAnalysis: 'Sube un archivo y haz clic en Analizar para obtener un análisis con IA',
  analyzeAction: 'Analizar',
  analysisError: 'Error de análisis',
  analyzing: (name) => name ? `Analizando "${name}"...` : 'Analizando...',
  thinkingHint: 'El modelo está pensando y razonando...',
  reasoning: 'Razonamiento del modelo',
  tokens: 'tokens',
  summary: 'Resumen',
  keyObservations: 'Observaciones clave',
  contentClassification: 'Clasificación del contenido',
  extractedText: 'Texto extraído',
  mode: 'Modo',
  fast: 'Rápido',
  slow: 'Lento',
  processedIn: (s) => `Procesado en ${s}s`,
  truncated: 'Truncado',
  truncatedTooltip: 'El modelo alcanzó el límite de tokens — el razonamiento o la respuesta pueden estar truncados',
  noTextDetected: 'No se detectó texto.',
  pdfPlaceholder: 'PDF',
  previewEmpty: 'Sin archivos subidos',
  languageLabel: 'Idioma',
};

const bn: Translations = {
  appSubtitle: 'Powered by Nvidia RTX 5090 · Blackwell Architecture',
  uploadTitle: 'এখানে ফাইল টেনে আনুন',
  uploadTitleDrag: 'এখানে ফাইল ছেড়ে দিন',
  uploadSubtitle: 'অথবা ব্রাউজ করতে ক্লিক করুন',
  uploadHint: 'JPEG, PNG, WebP, GIF, BMP, TIFF, PDF — প্রতিটি ২০ MB পর্যন্ত',
  analyzeBtn: (n) => `${n}টি ফাইল বিশ্লেষণ করুন`,
  analyzingBtn: 'বিশ্লেষণ হচ্ছে...',
  submittingBtn: 'জমা হচ্ছে...',
  clearAll: 'সব মুছুন',
  statusConnecting: 'সংযোগ হচ্ছে...',
  statusReady: 'মডেল প্রস্তুত',
  statusNoModel: 'কোনো মডেল লোড নেই',
  statusOffline: 'ব্যাকএন্ড অফলাইন',
  statusLoadModel: 'LM Studio-তে একটি মডেল লোড করুন',
  failedChecks: (n) => `${n}টি ব্যর্থ পরীক্ষা`,
  emptyAnalysis: 'AI-চালিত বিশ্লেষণ পেতে একটি ফাইল আপলোড করুন এবং বিশ্লেষণ-এ ক্লিক করুন',
  analyzeAction: 'বিশ্লেষণ',
  analysisError: 'বিশ্লেষণ ত্রুটি',
  analyzing: (name) => name ? `"${name}" বিশ্লেষণ হচ্ছে...` : 'বিশ্লেষণ হচ্ছে...',
  thinkingHint: 'মডেল চিন্তা এবং যুক্তি করছে...',
  reasoning: 'মডেল যুক্তি',
  tokens: 'টোকেন',
  summary: 'সারসংক্ষেপ',
  keyObservations: 'মূল পর্যবেক্ষণ',
  contentClassification: 'বিষয়বস্তু শ্রেণীবিভাগ',
  extractedText: 'নিষ্কাশিত পাঠ্য',
  mode: 'মোড',
  fast: 'দ্রুত',
  slow: 'ধীর',
  processedIn: (s) => `${s} সেকেন্ডে প্রক্রিয়াকৃত`,
  truncated: 'কাটা হয়েছে',
  truncatedTooltip: 'মডেল টোকেন সীমায় পৌঁছেছে — যুক্তি বা প্রতিক্রিয়া কাটা হতে পারে',
  noTextDetected: 'কোনো পাঠ্য সনাক্ত হয়নি।',
  pdfPlaceholder: 'PDF',
  previewEmpty: 'কোনো ফাইল আপলোড হয়নি',
  languageLabel: 'ভাষা',
};

export const TRANSLATION_MAP: Record<Language, Translations> = { en, hi, es, bn };

/** The language instruction appended to the user prompt sent to the model */
export const MODEL_LANGUAGE_INSTRUCTIONS: Record<Language, string> = {
  en: '', // No extra instruction needed for English
  hi: 'IMPORTANT: Respond entirely in Hindi (हिन्दी). All text in the JSON — summary, observations, classification, and extracted text — must be written in Hindi.',
  es: 'IMPORTANT: Respond entirely in Spanish (Español). All text in the JSON — summary, observations, classification, and extracted text — must be written in Spanish.',
  bn: 'IMPORTANT: Respond entirely in Bengali (বাংলা). All text in the JSON — summary, observations, classification, and extracted text — must be written in Bengali.',
};
