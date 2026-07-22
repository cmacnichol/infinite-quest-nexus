# Publish the documentation with GitHub Pages

Infinite Quest Nexus publishes its VitePress documentation from the `main` branch to:

<https://cmacnichol.github.io/infinite-quest-nexus/>

The repository workflow builds documentation for pull requests without deploying it. A push to `main`, or a manual workflow run, builds the site, uploads `docs/.vitepress/dist`, and deploys that artifact through the `github-pages` environment.

## Prerequisites

- The repository must have GitHub Actions enabled.
- The actor merging or manually running the workflow must be allowed to run Actions.
- Repository or organization policy must permit the official GitHub Pages actions.
- The default branch must remain `main`, or the workflow and VitePress edit links must be updated together.

The workflow grants only `contents: read` to the build job. The deployment job receives `pages: write` and `id-token: write`; broad read/write workflow permissions are not required in repository settings.

## Enable Pages for the first time

1. Merge the Pages workflow and this documentation into `main`.
2. Open **Actions > Documentation** in the GitHub repository.
3. Wait for the workflow triggered by the push to finish, or select **Run workflow**, choose `main`, and run it manually.
4. Confirm that both the `build` and `deploy` jobs succeed.
5. Open <https://cmacnichol.github.io/infinite-quest-nexus/>.

The `Configure GitHub Pages` step uses first-run enablement, so the workflow normally creates the Pages site and selects GitHub Actions as its publishing source. If repository policy prevents automatic enablement, an administrator must open **Settings > Pages**, select **GitHub Actions** under **Build and deployment > Source**, and rerun the workflow.

GitHub creates the `github-pages` environment during the first deployment. Restrict that environment to the `main` branch if it is not already protected by repository policy.

## Publish documentation changes

1. Change Markdown, VitePress configuration, or documentation dependencies in a pull request.
2. Confirm that the `Documentation / build` check succeeds. Pull requests never upload or deploy a Pages artifact.
3. Merge the pull request into `main`.
4. Confirm that the push-triggered workflow completes the `deploy` job.

The workflow also runs when its own definition or the pnpm workspace and lock files change. Application-only changes do not redeploy an unchanged documentation site.

## Verify a deployment

In **Actions > Documentation**, open the workflow run and verify:

- `build` completed the VitePress build and uploaded the `github-pages` artifact.
- `deploy` configured Pages and created a deployment in the `github-pages` environment.
- The environment URL points to the published documentation.

The VitePress configuration defaults to the `/infinite-quest-nexus/` base path and the canonical GitHub Pages URL. If the repository is renamed or a custom domain is introduced, update `repositoryName`, `repositoryUrl`, and `siteUrl` in `docs/.vitepress/config.ts` before deploying.

## Troubleshoot deployment

- **Build succeeds but deploy is skipped:** verify that the run came from `main` or from `workflow_dispatch`; pull requests intentionally build without deploying.
- **Pages is not enabled:** select **GitHub Actions** in **Settings > Pages** and rerun the workflow.
- **Deployment is denied:** inspect the `github-pages` environment protection rules and confirm that `main` is an allowed deployment branch.
- **Assets return 404:** verify that the VitePress base path still matches the repository name exactly, including letter case.
- **The site shows an older version:** check the environment deployment linked from the workflow run, then rerun the latest successful `main` workflow.

See GitHub's [publishing-source guide](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) and [custom Pages workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) for platform-level requirements.
