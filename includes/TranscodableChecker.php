<?php

namespace MediaWiki\TimedMediaHandler;

use Config;
use File;
use MediaWiki\Title\Title;
use RepoGroup;

/**
 * @file
 * @ingroup Extensions
 */
class TranscodableChecker {
	/** @var Config */
	private $config;

	/** @var RepoGroup */
	private $repoGroup;

	/**
	 * @param Config $config
	 * @param RepoGroup $repoGroup
	 */
	public function __construct(
		Config $config,
		RepoGroup $repoGroup
	) {
		$this->config = $config;
		$this->repoGroup = $repoGroup;
	}

	/**
	 * Wraps the isTranscodableFile function
	 * @param Title $title
	 * @return bool
	 */
	public function isTranscodableTitle( $title ) {
		if ( $title->getNamespace() !== NS_FILE ) {
			return false;
		}
		$file = $this->repoGroup->findFile( $title );
		return $this->isTranscodableFile( $file );
	}

	/**
	 * Utility function to check if a given file can be "transcoded"
	 * @param File|false $file File object
	 * @return bool
	 */
	public function isTranscodableFile( $file ) {
		// don't show the transcode table if transcode is disabled
		if (
			!$this->config->get( 'EnableTranscode' ) &&
			!$this->config->get( 'EnabledAudioTranscodeSet' )
		) {
			return false;
		}
		// Can't find file
		if ( !$file ) {
			return false;
		}
		// We can only transcode local files
		if ( !$file->isLocal() ) {
			return false;
		}

		$handler = $file->getHandler();
		// Not able to transcode files without handler
		if ( !$handler ) {
			return false;
		}
		$mediaType = $handler->getMetadataType( $file );
		// If ogg or webm format and not audio we can "transcode" this file
		$isAudio = $handler instanceof TimedMediaHandler && $handler->isAudio( $file );
		if ( ( $mediaType === 'webm' || $mediaType === 'ogg'
				|| $mediaType === 'mp4' || $mediaType === 'mpeg' )
			&& !$isAudio
		) {
			return true;
		}
		if ( $isAudio && count( $this->config->get( 'EnabledAudioTranscodeSet' ) ) ) {
			return true;
		}
		return false;
	}
}
