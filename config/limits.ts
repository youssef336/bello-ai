/**
 * ⚙️ Daily limits — change a number, then push (or `npm run deploy`).
 *
 * حدود يومية زي Claude و ChatGPT: كل واحد ليه عدد في اليوم، وبيتجدد الساعة 00:00 UTC
 * (نفس الوقت اللي Cloudflare بيجدد فيه الرصيد المجاني). null = مفتوح من غير حد.
 * المالك يقدر يغيّر حدود أي عضو من صفحة الأعضاء؛ الأرقام دي هي اللي بتتطبق لو ما غيّرش.
 *
 * - messages: رسايل الشات. الأعضاء بيستخدموا مفاتيحهم، فالحد ده علشان الاستخدام يفضل معقول.
 * - images: صور اترسمت أو اتعدّلت. بتتعمل على Workers AI بتاع المالك (10,000 neuron في اليوم،
 *   الصورة ≈ 60–130)، فالحد بيحمي الرصيد المشترك.
 * - video: دقايق ترجمة مكتوبة للفيديو (Whisper على Workers AI، ≈ 47 neuron للدقيقة).
 *   تعديل الفيديو نفسه (قص، مقاس، كتم) بيحصل على الجهاز ومش بيتحسب.
 */
export const DAILY_LIMITS = {
  owner: { messages: null, images: 40, video: 30 },
  member: { messages: 150, images: 5, video: 5 },
} as const satisfies Record<'owner' | 'member', Record<'messages' | 'images' | 'video', number | null>>;

/**
 * كام تعديل صورة في اليوم بيتعمل بالموديل الأقوى (FLUX.2 klein 9B)، للمالك بس. التعديل الواحد
 * ≈ 1,550 neuron بدل ≈ 125، فالرقم ده بيحمي الرصيد اليومي (10,000). بعده التعديل بيكمل بالموديل
 * العادي. 0 = مقفول.
 */
export const BEST_EDITS_PER_DAY = 4;
