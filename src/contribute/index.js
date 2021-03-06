/* @license
 * This file is part of the Game Closure SDK.
 *
 * The Game Closure SDK is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * The Game Closure SDK is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.

 * You should have received a copy of the GNU General Public License
 * along with the Game Closure SDK.  If not, see <http://www.gnu.org/licenses/>.
 */

var fs = require('fs');
var ff = require('ff');
var path = require('path');
var clc = require('cli-color');

var common = require('../common');
var git = require('../git');
var Version = require('../shared/Version');
var logger = new common.Formatter('contribute');
var Repo = require('../Repo');

var _repos;
function forEachRepo (cb, ctx) {
	Object.keys(_repos).forEach(function (name) {
		cb.call(ctx, _repos[name]);
	});
}

exports.main = function (argv) {
	var cmd = argv[0];
	if (!cmd) { cmd = 'status'; }
	if (!(cmd in _commands)) { cmd = 'help'; }

	init();

	new (_commands[cmd])(argv.slice(1));
}

function init () {
	if (!_repos) {
		_repos = {};

		var repositories = common.config.get("contribute.repositories");
		if (!repositories) { return; }

		Object.keys(repositories).forEach(function (repoName) {
			var def = repositories[repoName];
			if (def.path) {
				_repos[repoName] = new Repo.create(def.name || repoName, def);
			}
		});
	}
}

var _commands = {};

_commands.fetch = Class(function () {

	this.constructor.help = "";

	this.init = function (argv) {

	}
});

_commands.status = Class(function () {

	this.constructor.help = "";

	this.init = function (argv, cb) {
		var f = ff(function () {
			forEachRepo(function (repo) {
				repo.checkRemotes(f.wait());
			});
		}, function () {
			forEachRepo(function (repo) {
				repo.fetchGC(f.wait());
			});
		}, function () {
			forEachRepo(function (repo) {
				var onFinish = f.wait();
				var f2 = ff(function() {
					repo.getCommitsSince(f2());
					repo.getStatus(f2());
				}, function (commits, status) {
					console.log("")
					repo.log(clc.bright.yellow("---- " + repo.name + " ----"));

					var summary = "";
					if (status.staged.length) {
						summary += clc.bright.green(status.staged.length + " files staged") + " for commit";
					}

					if (status.modified.length) {
						summary += (summary ? '; ' : '') + clc.bright.red(status.modified.length + " files modified") + " (not staged)";
					}

					if (summary) {
						repo.log(summary);
					}

					if (commits.from.length) {
						repo.log("");
						repo.log(repo.getRemoteBranchStr(), "has added", clc.bright.red(commits.from.length + " commits"), "that you have not merged in yet");
						repo.log("  ", "to see these commits:");
						repo.log("  ", clc.bright.white("basil contribute show " + repo.name + " unmerged"));
					}

					if (commits.to.length) {
						repo.log("");
						repo.log("you have added", clc.bright.red(commits.to.length + " commits"), "that are not merged upstream");
						repo.log("  ", "to see these commits:");
						repo.log("  ", "  ", clc.bright.white("basil contribute show " + repo.name + " commits"));
						repo.log("");
						repo.log("  ", "to submit a pull request:");
						repo.log("  ", "  ", clc.bright.white("basil contribute pullrequest " + repo.name));
					}
				}).error(function (err) {
					repo.log("unknown status for", repo.name);
					repo.log(err);
				}).cb(function () {
					console.log("");
				}).cb(onFinish);
			});
		}).error(function (e) {
			logger.error(e);
		}).cb(cb);
	}
});

// run prerelease to test the latest release
_commands.prerelease = Class(function () {
	// checkout remote branch
	// merge repo into master
	// push repo to origin

	// TODO: parse repos out of argv
	this.init = function (argv) {
		var f = ff(function () {
			new _commands.status(null, f());
		}, function () {
			prompt("warning: this will erase all uncommitted changes. type 'yes' to continue: ", f());
		}, function (response) {
			if (response == 'yes') {
				forEachRepo(function (repo) {
					repo.log("checking out", repo.getRemoteBranchStr());
					repo.git([
							['checkout', '-f', repo.getRemoteBranchStr()],
							['reset', '--hard', repo.getRemoteBranchStr()]], f());
				});
			} else {
				logger.log("cancelled");
			}
		});
	}
});

_commands.release = Class(function () {
	this.constructor.help = "";
	this.constructor.summary = "";

	this.init = function () {

		var argv = require("optimist")
			.usage('Usage: $0 -p --type [major|minor|patch] [--branch branch] [--channel channel]')
			.boolean("production")
			.string("author")
			.default("type", "patch")
			.default("branch", "master")
			.default("channel", "release")
			.default("test", false)
			.argv;

		// tag submodules
		// add submodules
		// update version and commit release
		// push all repos to remote
		// push each branch to release branch of each repo

		var sdkRepo = _repos['devkit'];

		var tag;
		var f = ff(function () {
			sdkRepo.getNextVersion(argv.channel, argv.type, f());
		}, function (nextVersion) {
			tag = nextVersion.toString();

			logger.log("releasing version", tag);

			var packagePath = common.paths.root("package.json");
			var package = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

			// write version without channel to be a valid npm version
			package.version = nextVersion.toString(true);

			// store the channel separately
			package.channel = nextVersion.channel;

			fs.writeFileSync(packagePath, JSON.stringify(package, null, '\t'));

			var paths = ['package.json'];
			forEachRepo(function (repo) {
				if (repo.location != '.') {
					paths.push(repo.location);
				}

				// tag all submodules
				if (!argv.test) {
					repo.git('tag', '-f', tag, f());
				}
			});
			
			logger.log("committing", paths.join(' '));

			// add all submodules
			if (!argv.test) {
				sdkRepo.git.apply(sdkRepo, ['add'].concat(paths).concat([f()]));
			}
		}, function () {
			// commit the submodules and package.json
			if (!argv.test) {
				sdkRepo.git('commit', '-m', "Releasing version " + tag, f());
				console.log("committing...");
			}
		}, function () {
			// push the commits to development remote
			forEachRepo(function (repo) {
				if (repo.release) {
					repo.log("pushing to", repo.remote, "HEAD:" + repo.releaseBranch);
					if (!argv.test) {
						repo.git('push', '-f', repo.remote, "HEAD:" + repo.releaseBranch, f());
					}
				}
			}, this);
		}, function () {
			// push the tags to development remote
			forEachRepo(function (repo) {
				if (repo.release) {
					repo.log("pushing", tag, "to", repo.remote);
					if (!argv.test) {
						repo.git('push', repo.remote, tag, f());
					}
				}
			});
		}, function () {
			// push the commits to release remote
			forEachRepo(function (repo) {
				if (repo.release) {
					repo.log("pushing to", repo.release.remote, "HEAD:" + repo.release.branch);
					if (!argv.test) {
						repo.git('push', '-f', repo.release.remote, "HEAD:" + repo.release.branch, f());
					}
				}
			});
		}, function () {
			// push the tags to release remote
			forEachRepo(function (repo) {
				if (repo.release) {
					repo.log("pushing to", repo.release.remote, tag);
					if (!argv.test) {
						repo.git('push', repo.release.remote, tag, f());
					}
				}
			});
		}, function () {
			new _commands.postrelease(argv);
		}).error(function (err) {
			logger.error("unexpected error");
			console.error(err);
		});
	}
});

// try to merge release branch into develop branch
_commands.postrelease = Class(function () {
	// checkout remote branch
	// merge repo into master
	// push repo to origin

	// TODO: parse repos out of argv
	this.init = function (argv, cb) {
		var f = ff(function () {
			new _commands.status(null, f());
		}, function () {
			forEachRepo(function (repo) {
				if (repo.release) {
					repo.log("trying to merge ", repo.remote, repo.releaseBranch, 'into', repo.branch);

					if (!argv || !argv.test) {
						repo.git([
								['checkout', '-f', repo.getRemoteBranchStr()],
								['reset', '--hard'],
								['pull', repo.remote, repo.releaseBranch],
								['push', repo.remote, "HEAD:" + repo.branch]
							], f());
					}
				}
			});
		}).error(function (err) {
			logger.error("unexpected error");
			console.error(err);
		}).cb(cb);
	}
});

function prompt (question, cb) {
	var stdin = process.stdin, stdout = process.stdout;

	stdin.resume();
	stdout.write(question);

	stdin.once('data', function (data) {
		stdin.pause();
		data = data.toString().trim();
		cb && cb(null, data);
	});
}

_commands['pull-request'] = Class(function () {

	this.constructor.help = "";

	this.init = function (argv) {
		var github = new GithubAPI({version: "3.0.0"});
		github.authenticate({
			type: "basic",
			username: username,
			password: password
		});
	}
});

_commands.show = Class(function () {

	this.constructor.summary = "";
	this.constructor.help = "";

	this.init = function (argv) {
		var repoName = argv[0];
		var what = argv[1];
		if (!(repoName in _repos)) {
			return logger.log("unknown repository", repoName);
		}
		var repo = _repos[repoName];
		switch (what) {
			case 'unmerged':
			case 'commits':
				repo.getCommitsSince(function (err, commits) {
					if (err) {
						repo.log("error:", err);
						return;
					}

					var logger;
					var list;
					if (what == 'unmerged') {
						list = commits.from;
						logger = new common.Formatter(repo.name + ':' + repo.remote);
					} else {
						list = commits.to;
						logger = new common.Formatter('local:' + repo.remote);
					}

					list.forEach(function (commit) {
						logger.log(commit);
					});
				});
		}
	}
});

_commands.help = Class(function () {

	this.init = function () {
		console.log("basil contribute [command] [options]");
		Object.keys(_commands).forEach(function (cmd) {
			console.log("\t" + cmd + "\t" + _commands[cmd].summary);
		});
	}

});
