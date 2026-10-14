-- A campaign-wide art style keeps every illustration in one visual language.
-- Exclusions move out of the positive prompt: diffusion models tend to draw
-- what a prompt names, even after "do not". Providers that accept a negative
-- prompt receive it directly; others receive it as a trailing "Avoid:" clause.
ALTER TABLE campaign_illustration_configs
  ADD COLUMN art_style text NOT NULL DEFAULT '' CHECK (char_length(art_style) <= 500),
  ADD COLUMN negative_prompt text NOT NULL
    DEFAULT 'text, captions, lettering, watermark, signature, logo, user interface, speech bubbles, border'
    CHECK (char_length(negative_prompt) <= 500);

-- Frozen per job so retries send the exclusions the job was created with.
ALTER TABLE image_jobs
  ADD COLUMN negative_prompt text NOT NULL DEFAULT '' CHECK (char_length(negative_prompt) <= 500);
