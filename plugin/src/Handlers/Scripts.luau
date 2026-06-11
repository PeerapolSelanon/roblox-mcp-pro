--!strict
-- Handler for manage_scripts: read/write script source, create scripts, and
-- surgical edits — line-range replace/insert/delete, search across scripts,
-- and find/replace with dry-run — so agents don't rewrite whole files.

local ScriptEditorService = game:GetService("ScriptEditorService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Serialize = require(script.Parent.Parent.Serialize)

local SCRIPT_CLASSES = { Script = true, LocalScript = true, ModuleScript = true }

local function readSource(inst: Instance): string?
	local ok, src = pcall(function()
		return ScriptEditorService:GetEditorSource(inst)
	end)
	if ok and type(src) == "string" then
		return src
	end
	local ok2, src2 = pcall(function()
		return (inst :: any).Source
	end)
	return ok2 and src2 or nil
end

local function writeSource(inst: Instance, source: string): (boolean, string?)
	local ok = pcall(function()
		ScriptEditorService:UpdateSourceAsync(inst, function()
			return source
		end)
	end)
	if ok then
		return true, nil
	end
	local ok2, err = pcall(function()
		(inst :: any).Source = source
	end)
	return ok2, ok2 and nil or tostring(err)
end

local function splitLines(source: string): { string }
	local lines = string.split(source, "\n")
	return lines
end

-- Escape Lua pattern magic characters so plain text can ride through gsub/find.
local function escapeLuaPattern(text: string): string
	return (string.gsub(text, "([%^%$%(%)%%%.%[%]%*%+%-%?])", "%%%1"))
end

local function resolveScript(path: any): (Instance?, string?)
	local inst = path and Serialize.resolve(path) or nil
	if not inst or not SCRIPT_CLASSES[inst.ClassName] then
		return nil, "script not found at: " .. tostring(path)
	end
	return inst, nil
end

-- Write the edited source inside one undo step; returns a uniform result table.
local function commitSource(inst: Instance, source: string, label: string): any
	local recording = ChangeHistoryService:TryBeginRecording("MCP manage_scripts " .. label)
	local ok, err = writeSource(inst, source)
	if recording then
		ChangeHistoryService:FinishRecording(
			recording,
			ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
		)
	end
	return { ok = ok, path = Serialize.path(inst), lineCount = #splitLines(source), error = err }
end

-- Find `pattern` in `source`; returns { {line, text} }. Plain text by default
-- (case-insensitive unless caseSensitive), or a Lua pattern when luaPattern.
local function searchSource(source: string, pattern: string, caseSensitive: boolean, luaPattern: boolean): { any }
	local matches = {}
	local needle = pattern
	if not luaPattern and not caseSensitive then
		needle = string.lower(needle)
	end
	for lineNo, text in splitLines(source) do
		local haystack = text
		if not luaPattern and not caseSensitive then
			haystack = string.lower(haystack)
		end
		local found = if luaPattern
			then select(1, string.find(haystack, pattern)) ~= nil
			else select(1, string.find(haystack, needle, 1, true)) ~= nil
		if found then
			table.insert(matches, { line = lineNo, text = text })
		end
	end
	return matches
end

-- Collect every script under `root` (or root itself if it is a script).
local function collectScripts(root: Instance): { Instance }
	local scripts = {}
	if SCRIPT_CLASSES[root.ClassName] then
		table.insert(scripts, root)
	end
	for _, inst in root:GetDescendants() do
		if SCRIPT_CLASSES[inst.ClassName] then
			table.insert(scripts, inst)
		end
	end
	return scripts
end

return function(args: any): any
	local action = args.action or "get_source"

	if action == "get_source" then
		local inst, err = resolveScript(args.path)
		if not inst then
			return { ok = false, error = err }
		end
		local source = readSource(inst) or ""
		local lines = splitLines(source)
		local startLine = tonumber(args.start_line)
		local endLine = tonumber(args.end_line)
		if startLine or endLine then
			local first = math.max(1, startLine or 1)
			local last = math.min(#lines, endLine or #lines)
			local slice = {}
			for i = first, last do
				table.insert(slice, lines[i])
			end
			source = table.concat(slice, "\n")
		end
		return {
			ok = true,
			path = Serialize.path(inst),
			className = inst.ClassName,
			lineCount = #lines,
			source = source,
		}
	elseif action == "edit_replace" or action == "edit_delete" then
		local inst, err = resolveScript(args.path)
		if not inst then
			return { ok = false, error = err }
		end
		local lines = splitLines(readSource(inst) or "")
		local startLine = tonumber(args.start_line)
		local endLine = tonumber(args.end_line) or startLine
		if not startLine or startLine < 1 or not endLine or endLine > #lines or endLine < startLine then
			return {
				ok = false,
				error = `invalid line range {tostring(args.start_line)}..{tostring(args.end_line)} (script has {#lines} lines)`,
			}
		end
		local out = {}
		for i = 1, startLine - 1 do
			table.insert(out, lines[i])
		end
		if action == "edit_replace" then
			for _, newLine in splitLines(tostring(args.new_content or "")) do
				table.insert(out, newLine)
			end
		end
		for i = endLine + 1, #lines do
			table.insert(out, lines[i])
		end
		return commitSource(inst, table.concat(out, "\n"), action)
	elseif action == "edit_insert" then
		local inst, err = resolveScript(args.path)
		if not inst then
			return { ok = false, error = err }
		end
		local lines = splitLines(readSource(inst) or "")
		local afterLine = tonumber(args.after_line)
		if not afterLine or afterLine < 0 or afterLine > #lines then
			return { ok = false, error = `after_line must be 0..{#lines} (0 inserts at the top)` }
		end
		local out = {}
		for i = 1, afterLine do
			table.insert(out, lines[i])
		end
		for _, newLine in splitLines(tostring(args.content or "")) do
			table.insert(out, newLine)
		end
		for i = afterLine + 1, #lines do
			table.insert(out, lines[i])
		end
		return commitSource(inst, table.concat(out, "\n"), action)
	elseif action == "search" then
		local pattern = args.pattern
		if type(pattern) ~= "string" or pattern == "" then
			return { ok = false, error = "search requires pattern" }
		end
		local root = Serialize.resolve(args.path or "game")
		if not root then
			return { ok = false, error = "path not found: " .. tostring(args.path) }
		end
		local caseSensitive = args.case_sensitive == true
		local luaPattern = args.lua_pattern == true
		local maxResults = tonumber(args.max_results) or 100
		local results = {}
		local total = 0
		for _, scriptInst in collectScripts(root) do
			local source = readSource(scriptInst)
			if source then
				for _, match in searchSource(source, pattern, caseSensitive, luaPattern) do
					total += 1
					if total <= maxResults then
						table.insert(results, {
							path = Serialize.path(scriptInst),
							line = match.line,
							text = match.text,
						})
					end
				end
			end
		end
		return { ok = true, total = total, matches = results }
	elseif action == "replace" then
		local inst, err = resolveScript(args.path)
		if not inst then
			return { ok = false, error = err }
		end
		local pattern = args.pattern
		if type(pattern) ~= "string" or pattern == "" then
			return { ok = false, error = "replace requires pattern" }
		end
		local replacement = tostring(args.replacement or "")
		local luaPattern = args.lua_pattern == true
		local source = readSource(inst) or ""
		local findPattern = if luaPattern then pattern else escapeLuaPattern(pattern)
		local fixedReplacement = if luaPattern then replacement else (string.gsub(replacement, "%%", "%%%%"))
		local newSource, count = string.gsub(source, findPattern, fixedReplacement)
		if args.dry_run == true then
			return { ok = true, path = Serialize.path(inst), replacements = count, dryRun = true }
		end
		if count == 0 then
			return { ok = false, path = Serialize.path(inst), replacements = 0, error = "pattern not found" }
		end
		local result = commitSource(inst, newSource, action)
		result.replacements = count
		return result
	elseif action == "get_dependencies" then
		-- Static require() scan: find what this script depends on without
		-- running it. Handles game.-rooted, GetService, and script-relative
		-- references; dynamic requires are reported unresolved.
		local inst, err = resolveScript(args.path)
		if not inst then
			return { ok = false, error = err }
		end
		local source = readSource(inst) or ""
		local scriptPath = Serialize.path(inst)
		local deps = {}
		local seen: { [string]: boolean } = {}
		for parenthesized in string.gmatch(source, "require%s*(%b())") do
			local expr = string.sub(parenthesized, 2, -2)
			expr = string.gsub(expr, "^%s+", "")
			expr = string.gsub(expr, "%s+$", "")
			if not seen[expr] then
				seen[expr] = true
				local entry: any = { expression = expr }
				if string.match(expr, "^%d+$") then
					entry.kind = "assetId"
				else
					-- Normalize common access forms into a dotted path we can resolve.
					local pathExpr = expr
					pathExpr = string.gsub(pathExpr, 'game:GetService%s*%(%s*["\']([%w_]+)["\']%s*%)', "game.%1")
					pathExpr = string.gsub(pathExpr, ':WaitForChild%s*%(%s*["\']([%w_]+)["\']%s*%)', ".%1")
					pathExpr = string.gsub(pathExpr, ':FindFirstChild%s*%(%s*["\']([%w_]+)["\']%s*%)', ".%1")
					pathExpr = string.gsub(pathExpr, '%[%s*["\']([%w_]+)["\']%s*%]', ".%1")
					-- Resolve script-relative references against this script's path.
					if string.match(pathExpr, "^script%f[%W]") then
						pathExpr = scriptPath .. string.sub(pathExpr, #"script" + 1)
					end
					while true do
						local collapsed = string.gsub(pathExpr, "%.[%w_]+%.Parent", "", 1)
						if collapsed == pathExpr then
							break
						end
						pathExpr = collapsed
					end
					if string.match(pathExpr, "^game[%.%w_]*$") then
						local target = Serialize.resolve(pathExpr)
						entry.kind = "instance"
						entry.path = pathExpr
						entry.exists = target ~= nil
						if target then
							entry.path = Serialize.path(target)
							entry.className = target.ClassName
						end
					else
						entry.kind = "dynamic"
					end
				end
				table.insert(deps, entry)
			end
		end
		return { ok = true, path = scriptPath, count = #deps, dependencies = deps }
	elseif action == "delete" then
		local inst, err = resolveScript(args.path)
		if not inst then
			return { ok = false, error = err }
		end
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_scripts delete")
		local p = Serialize.path(inst)
		inst:Destroy()
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end
		return { ok = true, path = p }
	elseif action == "set_source" then
		local inst = args.path and Serialize.resolve(args.path) or nil
		if not inst or not SCRIPT_CLASSES[inst.ClassName] then
			return { ok = false, error = "script not found at: " .. tostring(args.path) }
		end
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_scripts set_source")
		local ok, err = writeSource(inst, tostring(args.source))
		if recording then
			ChangeHistoryService:FinishRecording(
				recording,
				ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
			)
		end
		return { ok = ok, path = Serialize.path(inst), error = err }
	elseif action == "create" then
		local className = args.class_name or "ModuleScript"
		if not SCRIPT_CLASSES[className] then
			return { ok = false, error = "class_name must be Script/LocalScript/ModuleScript" }
		end
		local parent = args.parent and Serialize.resolve(args.parent) or nil
		if not parent then
			return { ok = false, error = "parent not found: " .. tostring(args.parent) }
		end
		local recording = ChangeHistoryService:TryBeginRecording("MCP manage_scripts create")
		local inst = Instance.new(className)
		if args.name then
			inst.Name = args.name
		end
		if args.source then
			pcall(function()
				(inst :: any).Source = tostring(args.source)
			end)
		end
		inst.Parent = parent
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end
		return { ok = true, path = Serialize.path(inst) }
	else
		return { ok = false, error = "unknown manage_scripts action: " .. tostring(action) }
	end
end
