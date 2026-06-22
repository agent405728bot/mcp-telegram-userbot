# GitHub Packages Login Guide

## Step 1: Create a GitHub Personal Access Token

1. Go to https://github.com/settings/tokens
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Give it a name (e.g., `npm-token`)
4. Select scopes:
   - ✅ `read:packages` (to install packages)
   - ✅ `write:packages` (to publish packages)
   - ✅ `delete:packages` (optional, for deleting packages)
5. Click **"Generate token"**
6. **Copy the token** (you won't see it again!)

---

## Step 2: Configure npm to use GitHub Packages

### **Option A: Interactive Login (Easiest)**

```bash
npm login --registry https://npm.pkg.github.com
```

When prompted:
- **Username**: `YOUR_GITHUB_USERNAME`
- **Password**: Paste your **token** (not your GitHub password)
- **Email**: Your GitHub email

Example:
```
npm login --registry https://npm.pkg.github.com
Username: agent405728bot
Password: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Email: your-email@example.com
```

This creates/updates `~/.npmrc` automatically.

---

### **Option B: Manual `.npmrc` Setup**

Create or edit `~/.npmrc`:

```bash
@agent405728bot:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Replace `ghp_xxx...` with your actual token.

---

### **Option C: Environment Variable (for CI/scripts)**

```bash
export NPM_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
npm install @agent405728bot/mcp-telegram-userbot
```

---

## Step 3: Verify Login

```bash
npm whoami --registry https://npm.pkg.github.com
```

Should output your GitHub username.

---

## Step 4: Install the Package

```bash
npm install @agent405728bot/mcp-telegram-userbot
```

Or use npx:

```bash
npx @agent405728bot/mcp-telegram-userbot
```

---

## Troubleshooting

### **"401 Unauthorized"**
- Token expired or incorrect
- Try creating a new token
- Make sure you selected `read:packages` scope

### **"403 Forbidden"**
- You don't have access to the package
- Ask the repo owner to add you as a collaborator

### **"npm ERR! no such package"**
- Package hasn't been published yet
- Try `npm version patch && git push origin main --tags` in the repo to trigger publish

---

## One-liner Setup

If you have your token ready:

```bash
npm config set @agent405728bot:registry https://npm.pkg.github.com
npm config set //npm.pkg.github.com/:_authToken ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
npm install @agent405728bot/mcp-telegram-userbot
```

---

## Security Tips

⚠️ **Never commit your token to git!**

- Add to `.gitignore`: `~/.npmrc`
- Use environment variables in CI/CD
- Rotate tokens regularly
- Delete unused tokens

