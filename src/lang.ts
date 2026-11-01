export type Language = 'ar' | 'en';
export type Task = 'code' | 'reasoning' | 'general';

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/g;
const LATIN = /[A-Za-z]/g;

/** Arabic when Arabic letters are at least a third of all letters (code and English terms mix in). */
export function detectLanguage(text: string): Language {
  const ar = text.match(ARABIC)?.length ?? 0;
  const en = text.match(LATIN)?.length ?? 0;
  if (ar === 0) return 'en';
  return ar * 2 >= en ? 'ar' : 'en';
}

const CODE_HINTS =
  /```|\b(code|bug|error|exception|stack ?trace|function|class|compile|refactor|sql|regex|api|flutter|dart|python|typescript|javascript|kotlin|swift)\b|كود|برمج|باج|ايرور|إيرور/i;
const REASONING_HINTS =
  /\b(why|prove|compare|analy[sz]e|plan|design|architecture|trade-?offs?|step by step|calculate)\b|ليه|لماذا|قارن|حلل|خطة|صمم|احسب|خطوة بخطوة/i;

export function classifyTask(text: string): Task {
  if (CODE_HINTS.test(text)) return 'code';
  if (REASONING_HINTS.test(text) || text.length > 1500) return 'reasoning';
  return 'general';
}
