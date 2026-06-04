--!strict
-- Handler for sync_watch: emit Studio->server change events so the server can
-- mirror live edits to disk. action = "watch" | "unwatch".

local ScriptEditorService = game:GetService("ScriptEditorService")
local Serialize = require(script.Parent.Parent.Serialize)
local Bridge = require(script.Parent.Parent.Bridge)

local connections: { RBXScriptConnection } = {}
local watchedRoots: { Instance } = {}

local function isUnderRoots(inst: Instance): boolean
	for _, root in watchedRoots do
		if inst == root or inst:IsDescendantOf(root) then
			return true
		end
	end
	return false
end

local function clear()
	for _, conn in connections do
		conn:Disconnect()
	end
	table.clear(connections)
	table.clear(watchedRoots)
end

local function watch(roots: { string })
	clear()
	for _, rootPath in roots do
		local inst = Serialize.resolve(rootPath)
		if inst then
			table.insert(watchedRoots, inst)
			table.insert(
				connections,
				inst.DescendantAdded:Connect(function(desc: Instance)
					Bridge.postEvent({ kind = "added", path = Serialize.path(desc), data = { className = desc.ClassName } })
				end)
			)
			table.insert(
				connections,
				inst.DescendantRemoving:Connect(function(desc: Instance)
					Bridge.postEvent({ kind = "removing", path = Serialize.path(desc) })
				end)
			)
		end
	end

	-- Live script edits (fires as the user types in the Script Editor).
	table.insert(
		connections,
		ScriptEditorService.TextDocumentDidChange:Connect(function(document: ScriptDocument)
			local ok, scriptInst = pcall(function()
				return document:GetScript()
			end)
			if not ok or not scriptInst or not isUnderRoots(scriptInst) then
				return
			end
			local text = document:GetText()
			Bridge.postEvent({
				kind = "source_changed",
				path = Serialize.path(scriptInst),
				data = { className = scriptInst.ClassName, source = text },
			})
		end)
	)
end

return function(args: any): any
	local action = args.action or "watch"
	if action == "unwatch" then
		clear()
		return { watching = false }
	end
	watch(args.roots or {})
	return { watching = true, roots = #watchedRoots }
end
