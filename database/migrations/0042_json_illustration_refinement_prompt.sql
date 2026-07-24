UPDATE prompt_template_overrides
   SET content = regexp_replace(content,
     'Output ONLY the final image prompt, structured in the following order, separated by commas:',
     'Output ONLY a valid JSON object containing a single "image_prompt" field. The image prompt string should be structured in the following order, separated by commas:'
   ),
   updated_at = now()
 WHERE prompt_key = 'illustration_refinement'
   AND content LIKE '%Output ONLY the final image prompt, structured in the following order, separated by commas:%';
