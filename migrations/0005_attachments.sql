-- Pictures and files sent with a message (JSON array, see src/attachments.ts), and the web pages
-- a searched answer was built from (JSON array of {title, url}).
ALTER TABLE messages ADD COLUMN attachments TEXT;
ALTER TABLE messages ADD COLUMN sources TEXT;

-- Groq and Gemini list no input types in their catalogs: these families read images.
UPDATE models SET supports_vision = 1
 WHERE (provider = 'gemini' AND (model LIKE 'gemini-%' OR model LIKE 'gemma-3%' OR model LIKE 'gemma-4%'))
    OR (provider = 'groq' AND (model LIKE '%llama-4%' OR model LIKE '%vision%'));
