/**
 * EMCP_WB_Exit.c - Close Workbench cleanly
 *
 * Optionally saves the open world, then exits. In game mode the exit runs half a
 * second later so the response is sent first. In edit mode the game call queue does
 * not tick, so the exit runs at once and the client treats the dropped response as success.
 *
 * Called via NET API TCP protocol: APIFunc = "EMCP_WB_Exit"
 */

class EMCP_WB_ExitRequest : JsonApiStruct
{
	bool save;

	void EMCP_WB_ExitRequest()
	{
		RegV("save");
	}
}

class EMCP_WB_ExitResponse : JsonApiStruct
{
	string status;
	string message;
	bool saved;

	void EMCP_WB_ExitResponse()
	{
		RegV("status");
		RegV("message");
		RegV("saved");
	}
}

class EMCP_WB_Exit : NetApiHandler
{
	static void DoExit()
	{
		Workbench.Exit(0);
	}

	override JsonApiStruct GetRequest()
	{
		return new EMCP_WB_ExitRequest();
	}

	override JsonApiStruct GetResponse(JsonApiStruct request)
	{
		EMCP_WB_ExitRequest req = EMCP_WB_ExitRequest.Cast(request);
		EMCP_WB_ExitResponse resp = new EMCP_WB_ExitResponse();

		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		WorldEditorAPI api;
		if (worldEditor)
			api = worldEditor.GetApi();

		// Save() opens a "Save world as" dialog (blocking the handler) for an unsaved world or in prefab edit mode.
		string worldPath;
		if (api)
			api.GetWorldPath(worldPath);
		if (req.save && worldPath != "" && !worldEditor.IsPrefabEditMode())
			resp.saved = worldEditor.Save();

		resp.status = "ok";
		resp.message = "Workbench is exiting";

		if (api && api.IsGameMode() && GetGame() && GetGame().GetCallqueue())
			GetGame().GetCallqueue().CallLater(DoExit, 500);
		else
			DoExit();

		return resp;
	}
}
