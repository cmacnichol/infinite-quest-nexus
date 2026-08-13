export function handleStoryEscape(event, { document, requestModalDismissal, closeNavigationMenus }) {
  if (event.key !== "Escape") return false;
  event.preventDefault();
  const topmostDialog = [...document.querySelectorAll("dialog[open]")].at(-1);
  if (topmostDialog) requestModalDismissal(topmostDialog);
  closeNavigationMenus();
  return true;
}
