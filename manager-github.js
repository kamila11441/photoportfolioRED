const GITHUB_API = "https://api.github.com";
const REPOSITORY_DEFAULTS = Object.freeze({ branch: "main", configPath: "site-data.js", imagePath: "assets/uploads" });
let repositoryToken = "";
let repositoryConnection = null;

function repoStatus(message, error) {
  const output = document.querySelector("#repoStatus");
  output.textContent = message;
  output.classList.toggle("error", Boolean(error));
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function cleanPath(path) {
  const value = path.trim().replace(/^\/+|\/+$/g, "");
  if (!value || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Use a repository-relative path without . or .. segments.");
  }
  return value;
}

async function githubRequest(path, options) {
  const response = await fetch(GITHUB_API + path, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + repositoryToken,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options && options.headers)
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || ("GitHub returned HTTP " + response.status + "."));
  }
  return body;
}

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeUtf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function parsePortfolioConfig(source) {
  const match = source.match(/window\.(?:PHOTOGRAPHY_SITE_DEFAULT|WIKTORIA_SITE_DEFAULT)\s*=\s*([\s\S]*?)\s*;\s*$/);
  if (!match) throw new Error("The config file is not a photography portfolio site-data.js file.");
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch (error) {
    const legacyJson = match[1]
      .replace(/(^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/gm, '$1"$2":')
      .replace(/,\s*([}\]])/g, "$1");
    try { value = JSON.parse(legacyJson); }
    catch (legacyError) { throw new Error("The portfolio config could not be parsed. Replace it with this template's site-data.js file."); }
  }
  if (!value || !Array.isArray(value.galleries)) throw new Error("The repository config has no gallery list.");
  return value;
}

function portfolioSlug(value) {
  return (value || "photographer")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "photographer";
}

function mergePortfolio(remote) {
  return {
    ...clone(window.PHOTOGRAPHY_SITE_DEFAULT),
    ...remote,
    bio: { ...window.PHOTOGRAPHY_SITE_DEFAULT.bio, ...remote.bio },
    location: { ...window.PHOTOGRAPHY_SITE_DEFAULT.location, ...remote.location },
    galleries: remote.galleries || []
  };
}

document.querySelector("#connectRepo").addEventListener("click", async () => {
  const owner = document.querySelector("#repoOwner").value.trim();
  const repo = document.querySelector("#repoName").value.trim();
  const branch = REPOSITORY_DEFAULTS.branch;
  const tokenField = document.querySelector("#repoToken");
  const token = tokenField.value.trim();
  const configPath = cleanPath(REPOSITORY_DEFAULTS.configPath);
  const imagePath = cleanPath(REPOSITORY_DEFAULTS.imagePath);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || !branch || !token) {
    repoStatus("Enter a valid owner, repository, branch, and token.", true);
    return;
  }

  const button = document.querySelector("#connectRepo");
  button.disabled = true;
  button.textContent = "Connecting…";
  repositoryToken = token;
  repoStatus("Checking repository access…");
  try {
    const repoData = await githubRequest("/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo));
    if (repoData.permissions && repoData.permissions.push === false) {
      throw new Error("This token can read the repository but cannot publish changes.");
    }
    const configDirectory = configPath.includes("/") ? configPath.slice(0, configPath.lastIndexOf("/")) : "";
    repositoryConnection = {
      owner, repo, branch, configPath, imagePath,
      repoImageDirectory: configDirectory ? configDirectory + "/" + imagePath : imagePath
    };
    document.querySelector("#loginPanel").hidden = true;
    document.querySelector("#managerApp").hidden = false;
    document.querySelector("#connectedLabel").textContent = "Connected: " + owner + "/" + repo + " · " + branch;
    document.querySelector("#managerBrand").textContent = draft.brand || "PHOTO";
    document.querySelector("#publishRepo").disabled = true;
    status("Connected. Loading portfolio content…");
    try {
      const file = await githubRequest(
        "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) +
        "/contents/" + encodePath(configPath) + "?ref=" + encodeURIComponent(branch)
      );
      if (file.type !== "file" || !file.content) throw new Error("The config file could not be read.");
      const remoteDraft = parsePortfolioConfig(decodeBase64Utf8(file.content));
      let hasLocalDraft = false;
      try { hasLocalDraft = Boolean(localStorage.getItem(KEY)); } catch (error) {}
      if (!hasLocalDraft || confirm("Load the repository version and replace the browser draft?")) {
        draft = mergePortfolio(remoteDraft);
        fillProfile();
        renderGalleries();
      }
      document.querySelector("#managerBrand").textContent = draft.brand || "PHOTO";
      document.querySelector("#publishRepo").disabled = false;
      status("Portfolio loaded. Edit the content, then publish when ready.");
    } catch (error) {
      status("Logged in, but the portfolio config could not be loaded: " + error.message + " Publishing is disabled until the config is readable.", true);
    }
  } catch (error) {
    repositoryToken = "";
    repositoryConnection = null;
    tokenField.value = "";
    repoStatus("Could not log in: " + error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Log in and open manager";
  }
});

document.querySelector("#logout").addEventListener("click", () => {
  repositoryToken = "";
  repositoryConnection = null;
  document.querySelector("#repoToken").value = "";
  document.querySelector("#publishRepo").disabled = true;
  document.querySelector("#managerApp").hidden = true;
  document.querySelector("#loginPanel").hidden = false;
  repoStatus("Logged out. Enter your repository token to continue.");
});

async function makeBlob(path, content, encoding) {
  const blob = await githubRequest(
    "/repos/" + encodeURIComponent(repositoryConnection.owner) + "/" +
    encodeURIComponent(repositoryConnection.repo) + "/git/blobs",
    { method: "POST", body: JSON.stringify({ content, encoding }) }
  );
  return { path, mode: "100644", type: "blob", sha: blob.sha };
}

function setPublishedImagePaths(value, files, pathByData) {
  function replace(source) {
    if (typeof source !== "string" || !source.startsWith("data:image/")) return source;
    if (pathByData.has(source)) return pathByData.get(source);
    const payload = source.slice(source.indexOf(",") + 1);
    if (!payload) throw new Error("An uploaded photograph is empty.");
    const extension = source.startsWith("data:image/png") ? "png" : "jpg";
    const name = portfolioSlug(draft.name || draft.brand);
    const fileName = name + "-" + Date.now() + "-" + (files.length + 1) + "." + extension;
    const publicPath = repositoryConnection.imagePath + "/" + fileName;
    const repoPath = repositoryConnection.repoImageDirectory + "/" + fileName;
    pathByData.set(source, publicPath);
    files.push({ path: repoPath, content: payload });
    return publicPath;
  }
  value.hero = replace(value.hero);
  value.portrait = replace(value.portrait);
  value.galleries.forEach(gallery => (gallery.shots || []).forEach(shot => { shot.src = replace(shot.src); }));
}

function showPublishResult(message, error) {
  status(message, error);
}

document.querySelector("#publishRepo").addEventListener("click", async () => {
  if (!repositoryConnection || !repositoryToken) {
    showPublishResult("Log in to GitHub again before publishing.", true);
    return;
  }
  collectProfile();
  const destination = repositoryConnection.owner + "/" + repositoryConnection.repo + " · " + repositoryConnection.branch;
  if (!confirm("Commit these portfolio changes to " + destination + "?")) return;

  const button = document.querySelector("#publishRepo");
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Publishing…";
  try {
    const published = clone(draft);
    const newImages = [];
    setPublishedImagePaths(published, newImages, new Map());
    const entries = [];
    for (const image of newImages) {
      entries.push(await makeBlob(image.path, image.content, "base64"));
    }
    const configSource = "window.PHOTOGRAPHY_SITE_DEFAULT = " + JSON.stringify(published, null, 2) + ";\n";
    entries.push(await makeBlob(repositoryConnection.configPath, encodeUtf8Base64(configSource), "base64"));

    const repoApi = "/repos/" + encodeURIComponent(repositoryConnection.owner) + "/" + encodeURIComponent(repositoryConnection.repo);
    const ref = await githubRequest(repoApi + "/git/ref/heads/" + encodeURIComponent(repositoryConnection.branch));
    const parentSha = ref.object.sha;
    const parent = await githubRequest(repoApi + "/git/commits/" + parentSha);
    const tree = await githubRequest(repoApi + "/git/trees", {
      method: "POST",
      body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries })
    });
    const commit = await githubRequest(repoApi + "/git/commits", {
      method: "POST",
      body: JSON.stringify({
        message: "Update " + (draft.name || "photography") + " portfolio",
        tree: tree.sha,
        parents: [parentSha]
      })
    });
    await githubRequest(repoApi + "/git/refs/heads/" + encodeURIComponent(repositoryConnection.branch), {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false })
    });

    draft = published;
    try { localStorage.setItem(KEY, JSON.stringify(draft)); } catch (error) {}
    fillProfile();
    renderGalleries();
    status("Draft saved locally.");
    showPublishResult("Published commit " + commit.sha.slice(0, 7) + ". The host may need a moment to deploy.", false);
  } catch (error) {
    showPublishResult("Publish failed: " + error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
