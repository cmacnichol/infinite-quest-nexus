export interface StoryEscapeDependencies {
  document: Document;
  requestModalDismissal(dialog: HTMLDialogElement): unknown;
  closeNavigationMenus(): unknown;
}

export function handleStoryEscape(event: KeyboardEvent, dependencies: StoryEscapeDependencies): boolean;
