<?php
/**
 * Job for transcode jobs
 *
 * @file
 * @ingroup JobQueue
 */

namespace MediaWiki\TimedMediaHandler\WebVideoTranscode;

use Exception;
use File;
use FSFile;
use InvalidArgumentException;
use Job;
use LogicException;
use MediaWiki\Config\Config;
use MediaWiki\Deferred\CdnCacheUpdate;
use MediaWiki\Logger\LoggerFactory;
use MediaWiki\MediaWikiServices;
use MediaWiki\Shell\Shell;
use MediaWiki\TimedMediaHandler\HLS\Segmenter;
use MediaWiki\TimedMediaHandler\TimedMediaHandler;
use MediaWiki\Title\Title;
use Shellbox\Command\BoxedCommand;
use TempFSFile;

/**
 * Job for web video transcode
 *
 * Support two modes
 * 1) non-free media transcode ( delays the media file being inserted,
 *    adds note to talk page once ready)
 * 2) derivatives for video ( makes new sources for the asset )
 *
 * @ingroup JobQueue
 */

class WebVideoTranscodeJob extends Job {

	/** @var TempFSFile|null */
	public $targetEncodeFile;

	/** @var TempFSFile|null */
	public $targetPlaylistFile;

	/** @var string|null|false */
	public $sourceFilePath;

	/** @var File */
	public $file;

	/** @var FSFile|null */
	public $source;

	/** @var FSFile|null */
	public $remuxSource;

	/** @var Config */
	private $config;

	/**
	 * @param Title $title
	 * @param array $params
	 * @param Config $config
	 */
	public function __construct( $title, $params, Config $config ) {
		if ( isset( $params['prioritized'] ) && $params['prioritized'] ) {
			$command = 'webVideoTranscodePrioritized';
		} else {
			$command = 'webVideoTranscode';
		}
		parent::__construct( $command, $title, $params );
		$this->removeDuplicates = true;
		$this->config = $config;
	}

	/**
	 * Accessor for MainConfig
	 * @return Config
	 */
	protected function getConfig(): Config {
		return $this->config;
	}

	/**
	 * Wrapper around debug logger
	 * @param string $msg
	 */
	private function output( $msg ) {
		LoggerFactory::getInstance( 'WebVideoTranscodeJob' )->debug( $msg );
	}

	/**
	 * @return File
	 */
	private function getFile() {
		if ( !$this->file ) {
			$this->file = MediaWikiServices::getInstance()->getRepoGroup()->getLocalRepo()
				->findFile( $this->title, [ 'latest' => true ] );
		}
		return $this->file;
	}

	/**
	 * @return string
	 */
	private function getTargetEncodePath() {
		if ( !$this->targetEncodeFile ) {
			$this->targetEncodeFile = $this->fileTarget();
		}
		return $this->targetEncodeFile->getPath();
	}

	/**
	 * @return string
	 */
	private function getTargetPlaylistPath() {
		if ( !$this->targetPlaylistFile ) {
			$this->targetPlaylistFile = $this->fileTarget( '.m3u8' );
		}
		return $this->targetPlaylistFile->getPath();
	}

	/**
	 * @param string $suffix
	 * @return TempFSFile
	 */
	private function fileTarget( $suffix = '' ) {
		$base = $this->getFile();
		$transcodeKey = $this->params[ 'transcodeKey' ];
		$file = WebVideoTranscode::getTargetEncodeFile( $base, $transcodeKey, $suffix );
		if ( !$file ) {
			throw new LogicException( 'Internal state error' );
		}
		$file->bind( $this );
		return $file;
	}

	/**
	 * purge temporary encode target
	 */
	private function purgeTargetEncodeFile() {
		if ( $this->targetEncodeFile ) {
			$this->targetEncodeFile->purge();
			$this->targetEncodeFile = null;
		}
		if ( $this->targetPlaylistFile ) {
			$this->targetPlaylistFile->purge();
			$this->targetPlaylistFile = null;
		}
	}

	/**
	 * @return string|false
	 */
	private function getSourceFilePath() {
		if ( !$this->sourceFilePath ) {
			$file = $this->getFile();
			$this->source = $file->repo->getLocalReference( $file->getPath() );
			if ( !$this->source ) {
				$this->sourceFilePath = false;
			} else {
				$this->sourceFilePath = $this->source->getPath();
			}
		}
		return $this->sourceFilePath;
	}

	/**
	 * Update the transcode table with failure time and error
	 * @param string $transcodeKey
	 * @param string $error
	 *
	 */
	private function setTranscodeError( $transcodeKey, $error ) {
		$lbFactory = MediaWikiServices::getInstance()->getDBLoadBalancerFactory();
		$dbw = $lbFactory->getPrimaryDatabase();
		$dbw->newUpdateQueryBuilder()
			->update( 'transcode' )
			->set( [
				'transcode_time_error' => $dbw->timestamp(),
				'transcode_error' => $error
			] )
			->where( [
					'transcode_image_name' => $this->getFile()->getName(),
					'transcode_key' => $transcodeKey
			] )
			->caller( __METHOD__ )
			->execute();
		$this->setLastError( $error );
	}

	/**
	 * Run the transcode request
	 * @return bool success
	 */
	public function run() {
		$transcodeKey = $this->params['transcodeKey'];

		try {
			// get a local pointer to the file
			$file = $this->getFile();

			// Validate the file exists:
			if ( !$file ) {
				$error = $this->title . ': File not found';
				$this->output( $error );
				$this->setTranscodeError( $transcodeKey, $error );
				return false;
			}

			// Validate the transcode key param:
			if ( !isset( WebVideoTranscode::$derivativeSettings[ $transcodeKey ] ) ) {
				$error = "Transcode key $transcodeKey not found, skipping";
				$this->output( $error );
				$this->setTranscodeError( $transcodeKey, $error );
				return false;
			}

			// Validate the source exists:
			if ( !$this->getSourceFilePath() || !is_file( $this->getSourceFilePath() ) ) {
				$status = $this->title . ': Source not found ' . $this->getSourceFilePath();
				$this->output( $status );
				$this->setTranscodeError( $transcodeKey, $status );
				return false;
			}

			$options = WebVideoTranscode::$derivativeSettings[ $transcodeKey ];

			if ( isset( $options[ 'novideo' ] ) ) {
				if ( !isset( $options['audioCodec'] ) ) {
					throw new LogicException( 'Invalid audio track options' );
				}
				$this->output( "Encoding to audio codec: " . $options['audioCodec'] );
			} else {
				if ( !isset( $options['videoCodec'] ) ) {
					throw new LogicException( 'Invalid video track options' );
				}
				$this->output( "Encoding to codec: " . $options['videoCodec'] );
			}
			$lbFactory = MediaWikiServices::getInstance()->getDBLoadBalancerFactory();
			$dbw = $lbFactory->getPrimaryDatabase();

			// Check if we have "already started" the transcode ( possible error )
			$dbStartTime = $dbw->newSelectQueryBuilder()
				->select( 'transcode_time_startwork' )
				->from( 'transcode' )
				->where( [
					'transcode_image_name' => $this->getFile()->getName(),
					'transcode_key' => $transcodeKey
				] )
				->caller( __METHOD__ )
				->fetchField();
			if ( $dbStartTime !== null ) {
				$error = 'Error, running transcode job, for job that has already started';
				$this->output( $error );
				return true;
			}

			// Update the transcode table letting it know we have "started work":
			$jobStartTimeCache = wfTimestamp( TS_UNIX );
			$dbw->newUpdateQueryBuilder()
				->update( 'transcode' )
				->set( [ 'transcode_time_startwork' => $dbw->timestamp( $jobStartTimeCache ) ] )
				->where( [
					'transcode_image_name' => $this->getFile()->getName(),
					'transcode_key' => $transcodeKey
				] )
				->caller( __METHOD__ )
				->execute();

			// Avoid contention and "server has gone away" errors as
			// the transcode will take a very long time in some cases
			$lbFactory->commitPrimaryChanges( __METHOD__ );
			$lbFactory->flushPrimarySessions( __METHOD__ );
			$lbFactory->flushReplicaSnapshots( __METHOD__ );
			// We can't just leave the connection open either or it will
			// eat up resources and block new connections, so make sure
			// everything is dead and gone.
			$lbFactory->closeAll();

			// Check the codec see which encode method to call;
			$streaming = $options['streaming'] ?? false;
			$videoCodec = $options['videoCodec'] ?? '';
			$codecs = [ 'vp8', 'vp9', 'h264', 'h263', 'mpeg4', 'mjpeg' ];
			$twopass = isset( $options['twopass'] );

			// Was the _job_ enqueued with the remux option variant?
			$remux = $this->params['remux'] ?? false;
			// Does the _transcode config_ have a list of remux sources?
			$remuxFrom = $options['remuxFrom'] ?? false;
			if ( $remux && $remuxFrom ) {
				foreach ( $remuxFrom as $altKey ) {
					$altSource = WebVideoTranscode::getDerivativeFilePath( $file, $altKey );
					$repo = $this->file->repo;
					if ( $repo->fileExists( $altSource ) ) {
						$remuxSource = $repo->getLocalReference( $altSource );
						if ( $remuxSource ) {
							$this->remuxSource = $remuxSource;
							$twopass = false;
							break;
						}
					}
				}
			}
			if ( isset( $options[ 'novideo' ] ) ) {
				if ( $file->getMimeType() === 'audio/midi' ) {
					$status = $this->midiToAudioEncode( $options );
				} else {
					$status = $this->ffmpegEncode( $options );
				}
			} elseif ( in_array( $videoCodec, $codecs ) ) {
				// Check for twopass:
				if ( $twopass ) {
					// ffmpeg requires manual two pass
					$status = $this->ffmpegEncode( $options, 2 );
				} else {
					$status = $this->ffmpegEncode( $options );
				}
			} else {
				wfDebug( 'Error unknown codec:' . $videoCodec );
				$status = 'Error unknown target encode codec:' . $videoCodec;
			}

			// Reconnect to the database...
			$dbw = $lbFactory->getPrimaryDatabase();

			// Do a quick check to confirm the job was not restarted or removed while we were transcoding
			// Confirm that the in memory $jobStartTimeCache matches db start time
			$dbStartTime = $dbw->newSelectQueryBuilder()
				->select( 'transcode_time_startwork' )
				->from( 'transcode' )
				->where( [
					'transcode_image_name' => $this->getFile()->getName(),
					'transcode_key' => $transcodeKey
				] )
				->caller( __METHOD__ )
				->fetchField();

			// Check for ( hopefully rare ) issue of or job restarted while transcode in progress
			if ( $dbStartTime === null || $jobStartTimeCache !== wfTimestamp( TS_UNIX, $dbStartTime ) ) {
				$this->output(
					'Possible Error,
						transcode task restarted, removed, or completed while transcode was in progress'
				);
				// if an error; just error out,
				// we can't remove temp files or update states, because the new job may be doing stuff.
				if ( $status !== true ) {
					$this->setTranscodeError( $transcodeKey, $status );
					return false;
				}
				// else just continue with db updates,
				// and when the new job comes around it won't start because it will see
				// that the job has already been started.
			}

			// If status is ok and target does not exist, reset status
			if ( $status === true && !is_file( $this->getTargetEncodePath() ) ) {
				$status = 'Target does not exist: ' . $this->getTargetEncodePath();
			}

			// If status is ok and target is larger than 0 bytes
			if ( $status === true && filesize( $this->getTargetEncodePath() ) > 0 ) {

				$file = $this->getFile();
				$mediaFilename = WebVideoTranscode::getTranscodeFileBaseName( $file, $transcodeKey );
				$mediaPath = WebVideoTranscode::getDerivativeFilePath( $file, $transcodeKey );
				$storeOptions = null;
				$playlistStoreOptions = null;

				if ( $streaming === 'hls' ) {
					$playlistKey = $transcodeKey . '.m3u8';
					$playlistFilename = WebVideoTranscode::getTranscodeFileBaseName( $file, $playlistKey );
					$playlistPath = WebVideoTranscode::getDerivativeFilePath( $file, $playlistKey );
					$playlistTemp = $this->getTargetPlaylistPath();

					$segmenter = Segmenter::segment( $this->getTargetEncodePath() );
					// @fixme put the 10-second segment target in a constant somewhere
					$segmenter->consolidate( 10 );
					$segmenter->rewrite();
					$playlist = $segmenter->playlist( 10, $mediaFilename );

					file_put_contents( $playlistTemp, $playlist );
					$playlistStoreOptions = [];
					$playlistStoreOptions['headers']['Content-Type'] = 'application/vnd.apple.mpegurl; charset=utf-8';
				} else {
					$playlistTemp = null;
					$playlistPath = null;
				}

				if (
					strpos( $options['type'], '/ogg' ) !== false &&
					$file->getLength()
				) {
					$storeOptions = [];
					// Ogg files need a duration header for firefox
					$storeOptions['headers']['X-Content-Duration'] = (float)$file->getLength();
				}

				// Avoid "server has gone away" errors as copying can be slow
				$lbFactory->commitPrimaryChanges( __METHOD__ );
				$lbFactory->flushPrimarySessions( __METHOD__ );
				$lbFactory->flushReplicaSnapshots( __METHOD__ );
				$lbFactory->closeAll();

				// Copy derivative from the FS into storage at $finalDerivativeFilePath
				$result = $file->getRepo()->quickImport(
					// temp file
					$this->getTargetEncodePath(),
					// storage
					$mediaPath,
					$storeOptions
				);
				if ( $result->isOK() && $streaming === 'hls' && $playlistTemp && $playlistPath ) {
					$result = $file->getRepo()->quickImport(
						// temp file
						$playlistTemp,
						// storage
						$playlistPath,
						$playlistStoreOptions
					);
					if ( $result->isOK() ) {
						WebVideoTranscode::updateStreamingManifests( $file );
					}
				}

				if ( !$result->isOK() ) {
					// no need to invalidate all pages with video.
					// Because all pages remain valid ( no $transcodeKey derivative )
					// just clear the file page ( so that the transcode table shows the error )
					$this->title->invalidateCache();
					$this->setTranscodeError( $transcodeKey, $result->getWikiText() );
					$status = false;
				} else {
					$bitrate = round(
						(int)( filesize( $this->getTargetEncodePath() ) / $file->getLength() ) * 8
					);
					// Wikimedia\restoreWarnings();
					// Reconnect to the database...
					$dbw = $lbFactory->getPrimaryDatabase();
					// Update the transcode table with success time:
					$dbw->newUpdateQueryBuilder()
						->update( 'transcode' )
						->set( [
							'transcode_error' => '',
							'transcode_time_error' => null,
							'transcode_time_success' => $dbw->timestamp(),
							'transcode_final_bitrate' => $bitrate
						] )
						->where( [
							'transcode_image_name' => $this->getFile()->getName(),
							'transcode_key' => $transcodeKey,
						] )
						->caller( __METHOD__ )
						->execute();
					// Commit to reduce contention
					$dbw->commit( __METHOD__, 'flush' );
					WebVideoTranscode::invalidatePagesWithFile( $this->title );
				}
			} else {
				// Update the transcode table with failure time and error
				$this->setTranscodeError( $transcodeKey, $status );
				// no need to invalidate all pages with video.
				// Because all pages remain valid ( no $transcodeKey derivative )
				// just clear the file page ( so that the transcode table shows the error )
				$this->title->invalidateCache();
			}
			// done with encoding target, clean up
			$this->purgeTargetEncodeFile();

			// Clear the webVideoTranscode cache ( so we don't keep out dated table cache around )
			WebVideoTranscode::clearTranscodeCache( $this->title->getDBkey() );

			$url = WebVideoTranscode::getTranscodedUrlForFile( $file, $transcodeKey );
			$urls = [ $url ];
			if ( $streaming === 'hls' ) {
				$urls[] = "$url.m3u8";
			}
			$update = new CdnCacheUpdate( $urls );
			$update->doUpdate();

			if ( $status !== true ) {
				$this->setLastError( $status );
			}
			return $status === true;
		} catch ( Exception $e ) {
			$error = "Exception: " . $e->getMessage();
			$trace = $e->getTraceAsString();
			$this->output( "$error\n$trace\n" );
			$this->setTranscodeError( $transcodeKey, $error );
			return false;
		}
	}

	/**
	 * Gets a boxedCommand executor
	 * @param string $name The route name for the BoxedCommand
	 * @return BoxedCommand
	 */
	private static function getCommand( string $name ) {
		$fullName = 'tmh-' . strtolower( $name );
		return MediaWikiServices::getInstance()->getShellCommandFactory()
			->createBoxed( 'timedmediahandler' )
			->disableNetwork()
			->firejailDefaultSeccomp()
			->routeName( $fullName );
	}

	/**
	 * Adds an input file from the scripts directory, sets the command to execute it
	 * @param BoxedCommand $command
	 * @param string $script
	 *
	 */
	private static function useScript( BoxedCommand $command, string $script ) {
		global $wgShellboxShell;
		$file = __DIR__ . "/../../scripts/$script";
		if ( !is_file( $file ) ) {
			throw new InvalidArgumentException( "File '$file' not found" );
		}
		$command->inputFileFromFile( "scripts/$script", $file )
			->params( $wgShellboxShell, 'scripts/' . $script );
	}

	/**
	 * Utility helper for ffmpeg mapping
	 * @param array $options
	 * @param int $passes the number of encoding passes to perform
	 * @return true|string
	 */
	private function ffmpegEncode( $options, $passes = 0 ) {
		if ( !is_file( $this->getSourceFilePath() ) ) {
			return "source file is missing, " . $this->getSourceFilePath() . ". Encoding failed.";
		}
		// Environment variables for shellbox
		$optsEnv = [];
		if ( $this->remuxSource ) {
			$sourcePath = $this->remuxSource->getPath();
		} else {
			$sourcePath = $this->getSourceFilePath();
		}

		$interval = 10;
		$fps = 0;
		// Set up all the video-related options
		if ( isset( $options['novideo'] ) ) {
			$optsEnv['TMH_OPTS_VIDEO'] = '-vn';
		} else {
			$optsEnv['TMH_OPTS_VIDEO'] = "";
			$fps = $this->effectiveFrameRate( $options );
			if ( isset( $options['framerate'] ) ) {
				// $options['framerate'] is a float
				$optsEnv['TMH_OPTS_VIDEO'] .= '-r ' . strval( $options['framerate'] );
			} else {
				// Note -fpsmax is not available on Wikimedia's Debian as of 2023-02-02
				//
				//   $cmd .= " -fpsmax " . wfEscapeShellArg( $options['fpsmax'] );
				//   $cmd .= " -fpsmax " . self::MAX_FPS;
				//
				// Instead, manually check the detected framerate.
				// Note some files report incorrectly via GetID3, and may
				// end up actually increasing in frame rate because of this!
				$orig = $this->frameRate();
				if ( $this->isInterlaced() ) {
					$orig *= 2;
				}
				if ( $orig > $fps ) {
					$optsEnv['TMH_OPTS_VIDEO'] .= '-r ' . strval( $fps );
				}
			}

			if ( $this->remuxSource ) {
				$optsEnv['TMH_OPTS_VIDEO'] .= ' -vcodec copy';
				$optsEnv['TMH_REMUX'] = "yes";
			} else {
				$optsEnv['TMH_REMUX'] = "no";
				$optsEnv['TMH_OPT_VIDEOCODEC'] = $options['videoCodec'];
				switch ( $options['videoCodec'] ) {
					case 'vp8':
					case 'vp9':
						$optsEnv['TMH_OPTS_VIDEO'] .= $this->ffmpegAddWebmVideoOptions( $options );
						if ( isset( $options['speed'] ) ) {
							$optsEnv['TMH_OPT_SPEED'] = (string)intval( $options['speed'] );
						}
						break;
					case 'h264':
						$optsEnv['TMH_OPTS_VIDEO'] .= $this->ffmpegAddH264VideoOptions( $options );
						break;
					case 'mpeg4':
						$optsEnv['TMH_OPTS_VIDEO'] .= $this->ffmpegAddMPEG4VideoOptions( $options );
						break;
					default:
						$optsEnv['TMH_OPTS_VIDEO'] .= $this->ffmpegAddGenericVideoOptions( $options );
				}
			}

			// needed for 2-pass & streaming to override file type detection
			if ( $options['videoCodec'] === 'h264' ||
				$options['videoCodec'] === 'mpeg4' ||
				isset( $options['streaming'] ) ) {
				$optsEnv['TMH_OPTS_VIDEO'] .= ' -f mp4';
			} elseif ( $options['videoCodec'] === 'vp8' ||
				$options['videoCodec'] === 'vp9' ) {
				$optsEnv['TMH_OPTS_VIDEO'] .= ' -f webm';
			}

			// Check for keyframeInterval
			$keyframeInterval = round( $fps * $interval );
			$optsEnv['TMH_OPTS_VIDEO'] .= ' -g ' . strval( $keyframeInterval );

			if ( isset( $options['videoBitrate'] ) ) {
				$base = $this->expandRate( $options['videoBitrate'] );
				$bitrate = $this->scaleRate( $options, $base );
				$optsEnv['TMH_OPTS_VIDEO'] .= " -b:v $bitrate";

				// Estimate the output file size in KiB and bail out early
				// if it's potentially very large. Could be a denial of
				// service, or just a large file that probably is poorly
				// compressed.
				$duration = (float)$this->file->getLength();
				$estimatedSize = round( ( $bitrate / 8 ) * $duration / 1024 );
				$backgroundSizeLimit = $this->config->get( 'TranscodeBackgroundSizeLimit' );
				if ( $backgroundSizeLimit > 0 && $estimatedSize > $backgroundSizeLimit ) {
					// This hard limit cannot be overridden by admins, except by raising the limit in config.
					// @todo return an error code that can be localized later
					return "estimated file size $estimatedSize KiB over hard limit $backgroundSizeLimit KiB";
				}

				$transcodeSoftSizeLimit = $this->config->get( 'TranscodeSoftSizeLimit' );
				if ( $transcodeSoftSizeLimit > 0 && $estimatedSize > $transcodeSoftSizeLimit ) {
					// This soft limit can be overridden when a transcode is reset by hand via the web UI
					// or API, or requeueTranscodes.php with --manual-override option.
					$manualOverride = $this->params['manualOverride'] ?? false;
					if ( !$manualOverride ) {
						// @todo return an error code that can be localized later
						return "estimated file size $estimatedSize KiB over soft limit $transcodeSoftSizeLimit KiB";
					}
				}

				if ( isset( $options['minrate'] ) ) {
					$minrate = $this->scaleRate( $options, $options['minrate'] );
					$optsEnv['TMH_OPTS_VIDEO'] .= " -minrate $minrate";
				}
				if ( isset( $options['maxrate'] ) ) {
					$maxrate = $this->scaleRate( $options, $options['maxrate'] );
					$optsEnv['TMH_OPTS_VIDEO'] .= " -maxrate $maxrate";
				}
			}

			if ( !$this->remuxSource ) {
				// If necessary, add deinterlacing options
				$optsEnv['TMH_OPTS_VIDEO'] .= $this->ffmpegAddDeinterlaceOptions( $options );
				// Add size options:
				$optsEnv['TMH_OPTS_VIDEO'] .= $this->ffmpegAddVideoSizeOptions( $options );
			}
		}

		if ( !MediaWikiServices::getInstance()->getMainConfig()->get( 'UseFFmpeg2' ) ) {
			// Work around https://trac.ffmpeg.org/ticket/6375 in ffmpeg 3.4/4.0
			// Sometimes caused transcode failures saying things like:
			// "1 frames left in the queue on closing"
			$optsEnv['TMH_OPTS_FFMPEG2'] = '-max_muxing_queue_size 1024';
		} else {
			$optsEnv['TMH_OPTS_FFMPEG2'] = '';
		}

		// Audio options
		$optsEnv['TMH_OPT_NOAUDIO'] = isset( $options['noaudio'] ) ? "yes" : "no";
		$optsEnv['TMH_OPTS_AUDIO'] = $this->ffmpegAddAudioOptions( $options );

		$streaming = $options['streaming'] ?? false;
		$transcodeKey = $this->params[ 'transcodeKey' ];
		$extension = substr( $transcodeKey, strrpos( $transcodeKey, '.' ) + 1 );

		if ( WebVideoTranscode::isBaseMediaFormat( $extension ) ) {
			$optsEnv['TMH_MOVFLAGS'] = '-movflags +faststart';
		}

		if ( $streaming === 'hls' ) {
			if ( WebVideoTranscode::isBaseMediaFormat( $extension ) ) {
				if ( !isset( $optsEnv['TMH_MOVFLAGS'] ) ) {
					$optsEnv['TMH_MOVFLAGS'] = '';
				}
				// Don't use the HLS muxer, as it'll want to manage
				// filenames and we have to rewrite everything anyway.
				// We'll generate an .m3u8 from the file structure after.

				if ( isset( $options['novideo'] ) || isset( $options['intraframe'] ) ) {
					// Audio-only tracks should be fragmented around the standard interval.
					// Intraframe-only codecs like Motion-JPEG should also be treated this way.
					$optsEnv['TMH_MOVFLAGS'] .= " -movflags +empty_moov+default_base_moof";
					$optsEnv['TMH_MOVFLAGS'] .= " -frag_duration {$interval}000000";
				} else {
					// Video keyframe interval is set to approximate the desired interval, but
					// they may occur whenever the encoder thinks they would be desirable such
					// as a visible scene change.
					$optsEnv['TMH_MOVFLAGS'] .= " -movflags +frag_keyframe+empty_moov+default_base_moof";
				}

				// This is needed for opus on debian bullseye
				$optsEnv['TMH_MOVFLAGS'] .= " -strict experimental";
			} elseif ( $extension === 'mp3' ) {
				// No additional options needed at present.
			} else {
				return "Invalid HLS track media type, expected .mp4, .m4v, .m4a, .mov, .3gp, or .mp3";
			}
		}

		$cmd = self::getCommand( 'ffmpegencode' );
		self::useScript( $cmd, 'ffmpeg-encode.sh' );
		// set up options that don't need mangling

		$backgroundMemoryLimit = $this->config->get( 'TranscodeBackgroundMemoryLimit' ) * 1024;
		$wallTimeLimit = (int)$this->config->get( 'TranscodeBackgroundTimeLimit' );
		$cpuTimeLimit = (int)$this->config->get( 'FFmpegThreads' ) * $wallTimeLimit;
		// cast to string to make phan happy
		$ffmpegLocation = (string)$this->config->get( 'FFmpegLocation' );
		// Create an output file name with the correct extension
		$target = $this->getTargetEncodePath();
		$outputFile = 'transcoded.' . pathinfo( $target, PATHINFO_EXTENSION );
		// Execute the conversion
		$cmd->outputFileToFile( $outputFile, $this->getTargetEncodePath() )
			->inputFileFromFile( 'original.video', $sourcePath )
			->includeStderr()
			->environment( [
				'TMH_OUTPUT_FILE'      => $outputFile,
				'TMH_FFMPEG_PASSES'    => strval( $passes ),
				'TMH_FFMPEG_PATH'      => $ffmpegLocation,
			] + $optsEnv );
		$result = $cmd->memoryLimit( $backgroundMemoryLimit )
			->wallTimeLimit( $wallTimeLimit )
			->cpuTimeLimit( $cpuTimeLimit )
			->execute();

		// and pass it to this->output()
		if ( $result->getExitCode() != 0 ) {
			return 'ffmpeg-encode.sh' .
				"\n\nExitcode: " . $result->getExitCode() . "\nMemory: $backgroundMemoryLimit\n\n"
				. $result->getStdout();
		}

		return true;
	}

	// Bitrates and keyframe distances are specified for this
	// common frame rate (30), and scaled accordingly to accomodate
	// higher frame rates.
	private const DEFAULT_FPS = 30;
	private const MAX_FPS = 60;
	private const MIN_FPS = 24;

	/**
	 * Scale a bitrate or frame count according to the frame rate
	 * of the file versus the default frame rate. This is not a
	 * straight linear multiplication; it's biased to reduce impact
	 * beyond 30 fps, to 1.5x base at 60 fps.
	 *
	 * @param array $options
	 * @param string|int $rate
	 * @return int
	 */
	private function scaleRate( $options, $rate ) {
		$fps = $this->effectiveFrameRate( $options );
		$base = $this->expandRate( $rate );

		$lofps = min( $fps, self::DEFAULT_FPS );
		$hifps = $fps - $lofps;
		$scaled = $base * $lofps / self::DEFAULT_FPS +
			0.5 * $base * $hifps / self::DEFAULT_FPS;
		return (int)$scaled;
	}

	/**
	 * Expand a bitrate that may have a k/m/g suffix
	 *
	 * @param string|int $rate
	 * @return int
	 */
	private function expandRate( $rate ) {
		return WebVideoTranscode::expandRate( $rate );
	}

	/**
	 * Grab the frame rate from the file, bounded by
	 * format-specific or generic limitations.
	 * Suitable for scaling linear parameters like the
	 * target bit rate.
	 *
	 * @param array $options
	 * @return float
	 */
	private function effectiveFrameRate( $options ) {
		if ( isset( $options['framerate'] ) ) {
			// fixed framerate
			$fps = $this->fractionToFloat( $options['framerate'] );
		} else {
			// @todo getid3 gets this wrong on some WebM input files
			// consider reading from ffmpeg or ffprobe...
			// We cap it, but this can cause a 29.97fps file to use
			// the 60fps bitrate. Worst case it's a bloated file.
			$fps = $this->frameRate();
		}
		if ( $this->shouldFrameDouble( $options ) ) {
			$fps *= 2;
		}

		if ( $fps < self::MIN_FPS ) {
			return self::MIN_FPS;
		}
		if ( isset( $options['fpsmax'] ) ) {
			$max = $this->fractionToFloat( $options['fpsmax'] );
		} else {
			$max = self::MAX_FPS;
		}
		if ( $fps > $max ) {
			return $max;
		}
		return $fps;
	}

	/**
	 * @param string $str
	 * @return float
	 */
	private function fractionToFloat( $str ) {
		$fraction = explode( '/', $str, 2 );
		if ( count( $fraction ) > 1 ) {
			return (float)$fraction[0] / (float)$fraction[1];
		}
		return (float)$str;
	}

	/**
	 * Return the actual frame rate of the file, or the default
	 * if can't retrieve it.
	 *
	 * @return float
	 */
	private function frameRate() {
		$file = $this->getFile();
		$handler = $file->getHandler();
		if ( $handler instanceof TimedMediaHandler ) {
			$fps = $handler->getFrameRate( $file );
			if ( $fps ) {
				return $fps;
			}
		}
		return self::DEFAULT_FPS;
	}

	/**
	 * Adds ffmpeg shell options for h264
	 *
	 * @param array $options
	 * @return string
	 */
	public function ffmpegAddH264VideoOptions( $options ) {
		// Set the codec:
		$cmd = " -threads " . (int)$this->config->get( 'FFmpegThreads' ) . " -vcodec libx264";
		$cmd .= ' -pix_fmt yuv420p';
		$cmd .= ' -rc-lookahead 16';

		return $cmd;
	}

	/**
	 * Adds ffmpeg shell options for h264
	 *
	 * @param array $options
	 * @return string
	 */
	public function ffmpegAddMPEG4VideoOptions( $options ) {
		$cmd = " -vcodec mpeg4";

		// Force to 4:2:0 chroma subsampling.
		$cmd .= ' -pix_fmt yuv420p';

		return $cmd;
	}

	/**
	 * @param array $options
	 * @return string
	 */
	private function ffmpegAddGenericVideoOptions( $options ) {
		$cmd = ' -vcodec ' . $options['videoCodec'];

		// Force to 4:2:0 chroma subsampling.
		$cmd .= ' -pix_fmt yuv420p';

		return $cmd;
	}

	/**
	 * @param array $options
	 *
	 * @return string
	 */
	private function ffmpegAddVideoSizeOptions( $options ) {
		$cmd = '';
		// Get a local pointer to the file object
		$file = $this->getFile();

		// Check for aspect ratio
		$aspectRatio = $options['aspect'] ?? $file->getWidth() . ':' . $file->getHeight();
		if ( ( isset( $options['width'] ) && $options['width'] > 0 )
			&&
			( isset( $options['height'] ) && $options['height'] > 0 )
		) {
			$cmd .= ' -s ' . (int)$options['width'] . 'x' . (int)$options['height'];
			$cmd .= ' -aspect ' . $aspectRatio;
		} elseif ( isset( $options['maxSize'] ) ) {
			// Get size transform ( if maxSize is > file, file size is used:

			[ $width, $height ] = WebVideoTranscode::getMaxSizeTransform( $file, $options['maxSize'] );
			$cmd .= ' -s ' . (int)$width . 'x' . (int)$height;
		}
		return $cmd;
	}

	/**
	 * Adds ffmpeg shell options for webm
	 *
	 * @param array $options
	 * @return string
	 */
	private function ffmpegAddWebmVideoOptions( $options ) {
		$cmd = ' -threads ' . (int)$this->config->get( 'FFmpegThreads' );
		if ( $this->config->get( 'FFmpegVP9RowMT' ) && $options['videoCodec'] === 'vp9' ) {
			// Macroblock row multithreading allows using more CPU cores
			// for VP9 encoding. This is not yet the default, and the option
			// will fail on a version of ffmpeg that is too old or is built
			// against a libvpx that is too old, so we have to enable it
			// conditionally for now.
			//
			// Requires libvpx 1.7 and ffmpeg 3.3.
			$cmd .= ' -row-mt 1';
		}

		// Force to 4:2:0 chroma subsampling. Others are supported in Theora
		// and in VP9 profile 1, but Chrome and Edge don't grok them.
		$cmd .= ' -pix_fmt yuv420p';

		// libvpx-specific constant quality or constrained quality
		// note the range is different between VP8 and VP9
		// Also an integer.
		if ( isset( $options['crf'] ) ) {
			$cmd .= " -crf " . (string)intval( $options['crf'] );
		}

		// Set the codec:
		if ( $options['videoCodec'] === 'vp9' ) {
			$cmd .= " -vcodec libvpx-vp9";
			if ( isset( $options['tileColumns'] ) ) {
				$cmd .= ' -tile-columns ' . (string)intval( $options['tileColumns'] );
			}
		} else {
			$cmd .= " -vcodec libvpx";
			if ( isset( $options['slices'] ) ) {
				$cmd .= ' -slices ' . (string)intval( $options['slices'] );
			}
		}

		$cmd .= ' -quality good';
		return $cmd;
	}

	/**
	 * @return bool
	 */
	private function isInterlaced() {
		$handler = $this->file->getHandler();
		return ( $handler instanceof TimedMediaHandler && $handler->isInterlaced( $this->file ) );
	}

	/**
	 * Whether to produce one frame per field when deinterlacing.
	 * This will double the output frame rate.
	 *
	 * @param array $options
	 * @return bool
	 */
	private function shouldFrameDouble( $options ) {
		if ( $this->isInterlaced() ) {
			if ( isset( $options['framerate'] ) ) {
				// Fixed framerate, don't mess with it.
				return false;
			}
			if ( isset( $options['fpsmax'] ) && $this->fractionToFloat( $options['fpsmax'] ) < 60 ) {
				return false;
			}
			return true;
		}
		return false;
	}

	/**
	 * @param array $options
	 * @return string
	 */
	private function ffmpegAddDeinterlaceOptions( $options ) {
		if ( $this->isInterlaced() ) {
			if ( $this->shouldFrameDouble( $options ) ) {
				// Send one frame per field for full motion smoothness.
				return ' -vf yadif=1';
			}
			// Send one frame per field
			return ' -vf yadif=0';
		}
		return '';
	}

	/**
	 * @param array $options
	 * @return string
	 */
	private function ffmpegAddAudioOptions( $options ) {
		$cmd = '';
		if ( isset( $options['audioQuality'] ) ) {
			$cmd .= " -aq " . (string)intval( $options['audioQuality'] );
		}
		if ( isset( $options['audioBitrate'] ) ) {
			$cmd .= " -ab " . $this->expandRate( $options['audioBitrate'] );
		}
		if ( isset( $options['samplerate'] ) ) {
			$cmd .= " -ar " . (string)intval( $options['samplerate'] );
		}
		if ( isset( $options['channels'] ) ) {
			$cmd .= " -ac " . (string)intval( $options['channels'] );
		}

		if ( isset( $options['audioCodec'] ) ) {
			$encoders = [
				'vorbis'	=> 'libvorbis',
				'opus'		=> 'libopus',
				'mp3'		=> 'libmp3lame',
			];
			$codec = $encoders[$options['audioCodec']] ?? $options['audioCodec'];
			$cmd .= " -acodec " . $codec;
			if ( $codec === 'aac' ) {
				// the aac encoder is currently "experimental" in libav 9? :P
				$cmd .= ' -strict experimental';
			}
		} else {
			// if no audio codec set use vorbis :
			$cmd .= " -acodec libvorbis ";
		}
		return $cmd;
	}

	/**
	 * Utility helper for midi to an audio format conversion
	 * @param array $options
	 * @return true|string
	 */
	private function midiToAudioEncode( $options ) {
		if ( !is_file( $this->getSourceFilePath() ) ) {
			return "source file is missing, " . $this->getSourceFilePath() . ". Encoding failed.";
		}
		$cmd = self::getCommand( 'miditoaudio' );
		self::useScript( $cmd, 'midi-encode.sh' );
		// set up options
		$optsEnv = [];
		$optToEnv = [
			'audioQuality' => 'QUALITY',
			'audioBitrate' => 'BITRATE',
			'samplerate' => 'SAMPLERATE',
			'channels' => 'CHANNELS'
		];
		foreach ( $optToEnv as $opt => $label ) {
			# Here we're passing the argument directly to the shell, so we want it escaped
			if ( isset( $options[$opt] ) ) {
				$optsEnv['TMH_OPT_' . $label] = Shell::escape( $options[$opt] );
			}
		}
		$outputFile = 'output_audio.' . pathinfo( $this->getTargetEncodePath(), PATHINFO_EXTENSION );
		// Execute the conversion
		$backgroundMemoryLimit = $this->config->get( 'TranscodeBackgroundMemoryLimit' ) * 1024;
		$wallTimeLimit = (int)$this->config->get( 'TranscodeBackgroundTimeLimit' );
		$cpuTimeLimit = (int)$this->config->get( 'FFmpegThreads' ) * $wallTimeLimit;
		$cmd->outputFileToFile( $outputFile, $this->getTargetEncodePath() )
			->inputFileFromFile( 'input.mid', $this->getSourceFilePath() )
			->includeStderr()
			->environment( [
				'TMH_FLUIDSYNTH_PATH' => $this->config->get( 'TmhFluidsynthLocation' ),
				'TMH_FFMPEG_PATH'     => $this->config->get( 'FFmpegLocation' ),
				'TMH_SOUNDFONT_PATH'  => $this->config->get( 'TmhSoundfontLocation' ),
				'TMH_AUDIO_CODEC'     => $options['audioCodec'],
				'TMH_OUTPUT_FILE'     => $outputFile,
			] + $optToEnv );
		$result = $cmd->memoryLimit( $backgroundMemoryLimit )
					->wallTimeLimit( $wallTimeLimit )
					->cpuTimeLimit( $cpuTimeLimit )
					->execute();

		if ( $result->getExitCode() != 0 ) {
			return 'midi-encode.sh' .
				"\n\nExitcode: " . $result->getExitCode() . "\nMemory: $backgroundMemoryLimit\n\n"
				. $result->getStdout();
		}
		return true;
	}

	/**
	 * Given all options are provided by our code, just ensure every option is shell safe
	 * with the strictest checks possible - basically we allow only [a-zA-Z] and "_-" in variables,
	 * else we pass then through Shell::escape. The reason why we're not using shell::escape directly
	 * is we're passing these values to a shell script where they'll be expanded unquoted from environment
	 * variables.
	 *
	 * @param string $value
	 * @return string
	 */
	private function ensureShellSafe( $value ) {
		if ( preg_match( '/^[a-zA-z\-_]+$/', $value ) === 1 ) {
			return $value;
		} else {
			return Shell::escape( $value );
		}
	}
}

class_alias( WebVideoTranscodeJob::class, 'WebVideoTranscodeJob' );
