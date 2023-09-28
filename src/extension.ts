import * as vscode from 'vscode';
import * as fs from 'fs';
import type { ArduinoContext } from 'vscode-arduino-api';
import { platform } from 'node:os';
import { spawn } from 'child_process';

const writeEmitter = new vscode.EventEmitter<string>();
let writerReady : boolean = false;

function makeTerminal(title : string) {
	// If it exists, move it to the front
	vscode.window.terminals.forEach( (w) => {
		if (w.name === title) {
			w.show(false);
			return;
		}
	});
	// Not found, make a new terminal
	const pty = {
		onDidWrite: writeEmitter.event,
		open: () => { writerReady = true; },
		close: () => { writerReady = false; },
		handleInput: () => {}
	};
	let terminal = (<any>vscode.window).createTerminal({name: title, pty});
	terminal.show();
}

function findTool(ctx: ArduinoContext, match : string) : string | undefined {
	let found = false;
	let ret = undefined;
	if (ctx.boardDetails !== undefined) {
		Object.keys(ctx.boardDetails.buildProperties).forEach( (elem) => {
			if (elem.startsWith(match) && !found && (ctx.boardDetails?.buildProperties[elem] !== undefined)) {
				ret = ctx.boardDetails.buildProperties[elem];
				found = true;
			}
		});
	}
	return ret;
}



export function activate(context: vscode.ExtensionContext) {
	// Get the Arduino info extension loaded
	const arduinoContext: ArduinoContext = vscode.extensions.getExtension('dankeboy36.vscode-arduino-api')?.exports;
	if (!arduinoContext) {
		// Failed to load the Arduino API.
		vscode.window.showErrorMessage("Unable to load the Arduino IDE Context extension.");
		return;
	}

	makeTerminal("LittleFS Upload");

	// Register the command
	const disposable = vscode.commands.registerCommand('arduino-littlefs-upload.uploadLittleFS', async () => {

		//let str = JSON.stringify(arduinoContext, null, 4);
		//console.log(str);

		if ((arduinoContext.boardDetails === undefined) ||  (arduinoContext.fqbn === undefined)){
			vscode.window.showErrorMessage("Board details not available. Compile the sketch once.");
			return;
		}

		// Wait for the terminal to become active.
		while (!writerReady) {
			await new Promise( resolve => setTimeout(resolve, 100) );
		}

		// Clear the terminal
		writeEmitter.fire('\x1b[2J\x1b[3J\x1b[;H');

		writeEmitter.fire("LittleFS Filesystem Uploader\r\n\r\n");

		// Need to have a data folder present, or this isn't gonna work...
		let dataFolder = arduinoContext.sketchPath + "/data";
		if (!fs.existsSync(dataFolder)) {
			writeEmitter.fire("ERROR: No data folder found\r\n");
			return;
		}

		// Figure out what we're running on
		let pico = false;
		let esp8266 = false;
		switch (arduinoContext.fqbn.split(':')[1]) {
			case "rp2040": {
				pico = true;
				break;
			}
			case "esp8266": {
				esp8266 = true;
				break;
			}
			default: {
				writeEmitter.fire("ERROR: Only Arduino-Pico RP2040 and ESP8266 supported.\r\n");
				return;
			}
		}

		// Need to find the selected menu item, then get the associated build values for the FS configuration
		let fsStart = 0;
		let fsEnd = 0;
		let page = 0;
		let blocksize = 0;
		let uploadSpeed = 115200; // ESP8266-only
		arduinoContext.boardDetails.configOptions.forEach( (opt) => {
			let optSeek = pico ? "flash" : "eesz";
			let startMarker = pico ? "fs_start" : "spiffs_start";
			let endMarker = pico ? "fs_end" : "spiffs_end";
			if (String(opt.option) === String(optSeek)) {
				opt.values.forEach( (itm) => {
					if (itm.selected) {
						let menustr = "menu." + optSeek + "." + itm.value + ".build.";
						fsStart = Number(arduinoContext.boardDetails?.buildProperties[menustr + startMarker]);
						fsEnd = Number(arduinoContext.boardDetails?.buildProperties[menustr + endMarker]);
						if (pico) { // Fixed-size always
							page = 256;
							blocksize = 4096;
						} else if (esp8266) {
							page = Number(arduinoContext.boardDetails?.buildProperties[menustr + "spiffs_pagesize"]);
							blocksize = Number(arduinoContext.boardDetails?.buildProperties[menustr + "spiffs_blocksize"]);
						}
					}
				});
			} else if (String(opt.option) === "baud") {
				opt.values.forEach( (itm) => {
					if (itm.selected) {
						uploadSpeed = Number(itm.value);
					}
				});
			}
		});
		if (!fsStart || !fsEnd || !page || !blocksize || (fsEnd <= fsStart)) {
			writeEmitter.fire("ERROR: No filesystem specified, check flash size menu\r\n");
			return;
		}

		// Windows exes need ".exe" suffix
		let ext = (platform() === 'win32') ? ".exe" : "";
		let mklittlefs = "mklittlefs" + ext;

		let tool = undefined;
		if (pico) {
			tool = findTool(arduinoContext, "runtime.tools.pqt-mklittlefs");
		} else { // ESP826
			tool = findTool(arduinoContext, "runtime.tools.mklittlefs");
		}
		if (tool) {
			mklittlefs = tool + "/" + mklittlefs;
		}

		// TBD - add non-serial UF2 upload via OpenOCD
		let serialPort = "";
		if (arduinoContext.port?.address === undefined) {
			writeEmitter.fire("ERROR: No port specified, check IDE menus.\r\n");
			return;
		} else {
			serialPort = arduinoContext.port?.address;
		}
		if (arduinoContext.port?.protocol !== "serial") {
			writeEmitter.fire("ERROR: Only serial port upload supported at this time.\r\n");
			return;
		}

		let python3 = "python3" + ext;
		let python3Path = undefined;
		if (pico) {
			python3Path = findTool(arduinoContext, "runtime.tools.pqt-python3");
		} else if (esp8266) {
			python3Path = findTool(arduinoContext, "runtime.tools.python3");
		}
		if (python3Path) {
			python3 = python3Path + "/" + python3;
		}

		// We can't always know where the compile path is, so just use a temp name
		const tmp = require('tmp');
		tmp.setGracefulCleanup();
		let imageFile = tmp.tmpNameSync({postfix: ".littlefs.bin"});

		let buildOpts =  ["-c", dataFolder, "-p", String(page), "-b", String(blocksize), "-s", String(fsEnd - fsStart), imageFile];

		// All mklittlefs take the same options, so run in common
		writeEmitter.fire("Building LittleFS filesystem\r\n");
		writeEmitter.fire(mklittlefs + " " + buildOpts.join(" ") + "\r\n");

		const mkfs = spawn(mklittlefs, buildOpts);
		for await (const chunk of mkfs.stdout) {
			writeEmitter.fire(String(chunk).replace(/\n/g, "\r\n"));
		}
		for await (const chunk of mkfs.stderr) {
			writeEmitter.fire(String(chunk).replace(/\n/g, "\r\n"));
		}
		// Wait until the executable finishes
		let exitCode = await new Promise( (resolve, reject) => {
			mkfs.on('close', resolve);
		});

		if (exitCode) {
			writeEmitter.fire("ERROR:  Mklittlefs failed, error code: " + String(exitCode) + "\r\n\r\n");
			return;
		}

		// Upload stage differs per core
		let uploadOpts : any[] = [];
		if (pico) {
			let uf2conv = "tools/uf2conv.py";
			let uf2Path = findTool(arduinoContext, "runtime.platform.path");
			if (uf2Path) {
				uf2conv = uf2Path + "/" + uf2conv;
			}
			uploadOpts = [uf2conv, "--base", String(fsStart), "--serial", serialPort, "--family", "RP2040", imageFile];
		} else {
			let upload = "tools/upload.py";
			let uploadPath = findTool(arduinoContext, "runtime.platform.path");
			if (uploadPath) {
				upload = uploadPath + "/" + upload;
			}
			uploadOpts = [upload, "--chip", "esp8266", "--port", serialPort, "--baud", String(uploadSpeed), "write_flash", String(fsStart), imageFile];
		}

		writeEmitter.fire("\r\n\r\nUploading LittleFS filesystem\r\n");
		writeEmitter.fire(python3 + " " + uploadOpts.join(" ") + "\r\n");
		const upld = spawn(python3, uploadOpts);
		for await (const chunk of upld.stdout) {
			writeEmitter.fire(String(chunk).replace(/\n/g, "\r\n"));
		}
		for await (const chunk of upld.stderr) {
			writeEmitter.fire(String(chunk).replace(/\n/g, "\r\n"));
		}
		// Wait until the executable finishes
		exitCode = await new Promise( (resolve, reject) => {
			upld.on('close', resolve);
		});

		if (exitCode) {
			writeEmitter.fire("ERROR:  Upload failed, error code: " + String(exitCode) + "\r\n\r\n");
			return;
		}

		writeEmitter.fire("\r\n\Completed upload.\r\n\r\n");
		vscode.window.showInformationMessage("LittleFS upload completed!");
	  });
	  context.subscriptions.push(disposable);
}

export function deactivate() {}