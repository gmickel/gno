import pathlib,subprocess,sys,json
root=pathlib.Path(sys.argv[1]);env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','GNO_NO_AUTO_DOWNLOAD':'1','GNO_LLAMA_GPU':'metal','GNO_LLAMA_BUILD':'never'}
paths={'HOME':'home','XDG_CONFIG_HOME':'config','XDG_DATA_HOME':'data','XDG_CACHE_HOME':'cache','XDG_STATE_HOME':'state','GNO_CONFIG_DIR':'config/gno','GNO_DATA_DIR':'data/gno','GNO_CACHE_DIR':'cache/gno','GNO_SKILLS_HOME_OVERRIDE':'skills/home','CLAUDE_SKILLS_DIR':'skills/claude','CODEX_SKILLS_DIR':'skills/codex','OPENCODE_SKILLS_DIR':'skills/opencode','OPENCLAW_SKILLS_DIR':'skills/openclaw','HERMES_SKILLS_DIR':'skills/hermes','APPDATA':'appdata','LOCALAPPDATA':'localappdata','USERPROFILE':'home','TEMP':'tmp','TMP':'tmp','TMPDIR':'tmp','npm_config_cache':'npm/cache','npm_config_prefix':'npm/prefix','npm_config_userconfig':'npm/config'}
for key,name in paths.items():
 p=root/'control-env'/name;p.mkdir(parents=True,exist_ok=True);env[key]=str(p)
(root/'evidence/control-environment.json').write_text(json.dumps(env,indent=2)+'\n')
sys.exit(subprocess.call([sys.argv[2],'--no-env-file',str(root/'control.ts'),str(root)],env=env))
