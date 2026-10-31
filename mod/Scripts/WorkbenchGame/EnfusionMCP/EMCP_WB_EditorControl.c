/**
 * EMCP_WB_EditorControl.c - Editor mode control handler
 *
 * Supports actions: play, stop, save, worldInfo, undo, redo, openResource (saveAs only returns an error)
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_EditorControl"
 */

class EMCP_WB_EditorControlRequest : JsonApiStruct
{
	string action;
	bool debugMode;
	bool fullScreen;
	string path;

	void EMCP_WB_EditorControlRequest()
	{
		RegV("action");
		RegV("debugMode");
		RegV("fullScreen");
		RegV("path");
	}
}

class EMCP_WB_EditorControlResponse : JsonApiStruct
{
	string status;
	string action;
	string message;
	bool saved;
	string worldPath;
	string absPath;
	bool prefabEditMode;
	bool gameMode;

	void EMCP_WB_EditorControlResponse()
	{
		RegV("status");
		RegV("action");
		RegV("message");
		RegV("saved");
		RegV("worldPath");
		RegV("absPath");
		RegV("prefabEditMode");
		RegV("gameMode");
	}
}

//! The one save guard (EditorControl save, Exit): Save() opens a blocking 'Save world as' dialog for an unnamed world or in prefab edit mode; no save during Play.
class EMCP_SaveGuard
{
	//! Why Save() must not be called now, or "" when it is safe.
	static string Refusal(WorldEditor worldEditor)
	{
		if (worldEditor.IsPrefabEditMode())
			return "Prefab edit mode: wb_save saves worlds. Use wb_prefabs save for the prefab.";
		WorldEditorAPI api = worldEditor.GetApi();
		string worldPath;
		if (api)
			api.GetWorldPath(worldPath);
		if (worldPath == "")
			return "No world file: the open world is unnamed, and saving it would open the blocking 'Save world as' dialog.";
		if (api.IsGameMode())
			return "Play mode: stop it with wb_stop before saving.";
		return "";
	}
}

class EMCP_WB_EditorControl : NetApiHandler
{
	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_EditorControlRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_EditorControlRequest req = EMCP_WB_EditorControlRequest.Cast(request);
		EMCP_WB_EditorControlResponse resp = new EMCP_WB_EditorControlResponse();
		resp.action = req.action;

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
		{
			resp.status = "error";
			resp.message = "WorldEditor module not available";
			return resp;
		}

		if (req.action == "play")
		{
			worldEditor.SwitchToGameMode(req.debugMode, req.fullScreen);
			resp.status = "ok";
			resp.message = "Switched to game mode";
		}
		else if (req.action == "stop")
		{
			worldEditor.SwitchToEditMode();
			resp.status = "ok";
			resp.message = "Switched to edit mode";
		}
		else if (req.action == "worldInfo")
		{
			WorldEditorAPI infoApi = worldEditor.GetApi();
			string infoPath;
			string infoAbs;
			if (infoApi)
			{
				infoApi.GetWorldPath(infoPath);
				resp.gameMode = infoApi.IsGameMode();
			}
			if (infoPath != "" && !Workbench.GetAbsolutePath(infoPath, infoAbs, true))
				infoAbs = "";
			resp.worldPath = infoPath;
			resp.absPath = infoAbs;
			resp.prefabEditMode = worldEditor.IsPrefabEditMode();
			resp.status = "ok";
		}
		else if (req.action == "save")
		{
			string refusal = EMCP_SaveGuard.Refusal(worldEditor);
			if (refusal != "")
			{
				resp.status = "error";
				resp.message = refusal;
			}
			else
			{
				// The TS side words a false result: its meaning is not documented.
				resp.saved = worldEditor.Save();
				resp.status = "ok";
				resp.message = "Save() returned " + resp.saved.ToString();
			}
		}
		else if (req.action == "saveAs")
		{
			resp.status = "error";
			resp.message = "Save As is not available in the 1.8 script API (WBModuleDef has only Save()). Nothing was saved.";
		}
		else if (req.action == "undo")
		{
			WorldEditorAPI api = worldEditor.GetApi();
			if (api)
			{
				// Undo is available via GameWorldEditor or WorldEditorIngame
				// Use ExecuteAction as a safe fallback
				array<string> menuPath = {};
				menuPath.Insert("Edit");
				menuPath.Insert("Undo");
				worldEditor.ExecuteAction(menuPath);
				resp.status = "ok";
				resp.message = "Undo executed";
			}
			else
			{
				resp.status = "error";
				resp.message = "WorldEditorAPI not available for undo";
			}
		}
		else if (req.action == "redo")
		{
			array<string> menuPath = {};
			menuPath.Insert("Edit");
			menuPath.Insert("Redo");
			worldEditor.ExecuteAction(menuPath);
			resp.status = "ok";
			resp.message = "Redo executed";
		}
		else if (req.action == "openResource")
		{
			if (req.path == "")
			{
				resp.status = "error";
				resp.message = "path parameter required for openResource action";
			}
			else
			{
				// Workbench.OpenResource picks the right editor (.c -> Script Editor, .et -> Prefab, .ent -> World)
				bool opened = Workbench.OpenResource(req.path);
				if (!opened)
					opened = worldEditor.SetOpenedResource(req.path);
				if (opened)
				{
					resp.status = "ok";
					resp.message = "Opened resource: " + req.path;
				}
				else
				{
					resp.status = "error";
					resp.message = "Workbench could not open: " + req.path + " (use a path relative to an addon, e.g. Scripts/Game/X.c, or a {GUID}path)";
				}
			}
		}
		else
		{
			resp.status = "error";
			resp.message = "Unknown action: " + req.action + ". Valid: play, stop, save, worldInfo, undo, redo, openResource";
		}

		return resp;
	}
}
