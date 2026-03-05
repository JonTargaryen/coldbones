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
  clearAll: string;
  emptyAnalysis: string;
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
}

const en: Translations = {
  appSubtitle: 'Powered by Nvidia RTX 5090 · Blackwell Architecture',
  uploadTitle: 'Drag & drop files here',
  uploadTitleDrag: 'Drop files here',
  uploadSubtitle: 'or click to browse',
  uploadHint: 'Images, PDF, Video (MP4, WebM, MOV) — up to 20 MB each',
  clearAll: 'Clear All',
  emptyAnalysis: 'Upload a file and click Analyze Now to get AI-powered analysis',
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
};

const hi: Translations = {
  appSubtitle: 'Powered by Nvidia RTX 5090 · Blackwell Architecture',
  uploadTitle: 'फ़ाइलें यहाँ खींचें और छोड़ें',
  uploadTitleDrag: 'फ़ाइलें यहाँ छोड़ें',
  uploadSubtitle: 'या ब्राउज़ करने के लिए क्लिक करें',
  uploadHint: 'Images, PDF, Video (MP4, WebM, MOV) — प्रत्येक 20 MB तक',
  clearAll: 'सब हटाएँ',
  emptyAnalysis: 'AI-संचालित विश्लेषण प्राप्त करने के लिए एक फ़ाइल अपलोड करें और Analyze Now पर क्लिक करें',
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
};

const es: Translations = {
  appSubtitle: 'Powered by Nvidia RTX 5090 · Blackwell Architecture',
  uploadTitle: 'Arrastra y suelta archivos aquí',
  uploadTitleDrag: 'Suelta los archivos aquí',
  uploadSubtitle: 'o haz clic para buscar',
  uploadHint: 'Images, PDF, Video (MP4, WebM, MOV) — hasta 20 MB cada uno',
  clearAll: 'Borrar todo',
  emptyAnalysis: 'Sube un archivo y haz clic en Analyze Now para obtener un análisis con IA',
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
};

const bn: Translations = {
  appSubtitle: 'Powered by Nvidia RTX 5090 · Blackwell Architecture',
  uploadTitle: 'এখানে ফাইল টেনে আনুন',
  uploadTitleDrag: 'এখানে ফাইল ছেড়ে দিন',
  uploadSubtitle: 'অথবা ব্রাউজ করতে ক্লিক করুন',
  uploadHint: 'Images, PDF, Video (MP4, WebM, MOV) — প্রতিটি ২০ MB পর্যন্ত',
  clearAll: 'সব মুছুন',
  emptyAnalysis: 'AI-চালিত বিশ্লেষণ পেতে একটি ফাইল আপলোড করুন এবং Analyze Now-এ ক্লিক করুন',
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
};

export const TRANSLATION_MAP: Record<Language, Translations> = { en, hi, es, bn };

/** The language instruction appended to the user prompt sent to the model */
export const MODEL_LANGUAGE_INSTRUCTIONS: Record<Language, string> = {
  en: '', // No extra instruction needed for English
  hi: 'IMPORTANT: Respond entirely in Hindi (हिन्दी). All text in the JSON — summary, observations, classification, and extracted text — must be written in Hindi.',
  es: 'IMPORTANT: Respond entirely in Spanish (Español). All text in the JSON — summary, observations, classification, and extracted text — must be written in Spanish.',
  bn: 'IMPORTANT: Respond entirely in Bengali (বাংলা). All text in the JSON — summary, observations, classification, and extracted text — must be written in Bengali.',
};
