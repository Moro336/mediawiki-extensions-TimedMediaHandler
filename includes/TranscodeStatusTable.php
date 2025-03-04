<?php

namespace MediaWiki\TimedMediaHandler;

use File;
use IContextSource;
use MediaWiki\Html\Html;
use MediaWiki\Linker\LinkRenderer;
use MediaWiki\TimedMediaHandler\WebVideoTranscode\WebVideoTranscode;
use MediaWiki\Utils\MWTimestamp;
use Xml;

/**
 * TranscodeStatusTable outputs a "transcode" status table to the ImagePage
 *
 * If logged in as autoconfirmed users can reset transcode states
 * via the transcode api entry point
 *
 */
class TranscodeStatusTable {
	/** @var IContextSource */
	private $context;

	/** @var LinkRenderer */
	private $linkRenderer;

	/**
	 * @param IContextSource $context
	 * @param LinkRenderer $linkRenderer
	 */
	public function __construct(
		IContextSource $context,
		LinkRenderer $linkRenderer
	) {
		$this->context = $context;
		$this->linkRenderer = $linkRenderer;
	}

	/**
	 * @param File $file
	 * @return string
	 */
	public function getHTML( $file ) {
		// Add transcode table css and javascript:
		$this->context->getOutput()->addModules( [ 'ext.tmh.transcodetable' ] );

		$o = '<h2 id="transcodestatus">' . wfMessage( 'timedmedia-status-header' )->escaped() . '</h2>';
		// Give the user a purge page link
		$o .= $this->linkRenderer->makeLink(
			$file->getTitle(),
			$this->context->msg( 'timedmedia-update-status' )->text(),
			[],
			[ 'action' => 'purge' ]
		);

		$o .= $this->getTranscodesTable( $file );

		return $o;
	}

	/**
	 * Get the video or audio codec for the defined transcode,
	 * for grouping/sorting purposes.
	 * @param string $key
	 * @return string
	 */
	public static function codecFromTranscodeKey( $key ) {
		if ( isset( WebVideoTranscode::$derivativeSettings[$key] ) ) {
			$settings = WebVideoTranscode::$derivativeSettings[$key];
			if ( isset( $settings['videoCodec'] ) ) {
				return $settings['videoCodec'];
			}

			if ( isset( $settings['audioCodec'] ) ) {
				return $settings['audioCodec'];
			}
			// else
			// this this shouldn't happen...
			// fall through
		}
		// else
		// derivative type no longer defined or invalid def?
		// fall through
		return $key;
	}

	/**
	 * @param File $file
	 * @return string
	 */
	public function getTranscodesTable( $file ) {
		$transcodeRows = WebVideoTranscode::getTranscodeState( $file );

		if ( !$transcodeRows ) {
			return '<p>' . wfMessage( 'timedmedia-no-derivatives' )->escaped() . '</p>';
		}

		uksort( $transcodeRows, static function ( $a, $b ) {
			$formatOrder = [ 'vp9', 'vp8', 'h264', 'theora', 'mjpeg', 'opus', 'mp3', 'vorbis', 'aac' ];

			$aFormat = self::codecFromTranscodeKey( $a );
			$bFormat = self::codecFromTranscodeKey( $b );
			$aIndex = array_search( $aFormat, $formatOrder );
			$bIndex = array_search( $bFormat, $formatOrder );

			if ( $aIndex === false && $bIndex === false ) {
				return -strnatcmp( $a, $b );
			}
			if ( $aIndex === false ) {
				return 1;
			}
			if ( $bIndex === false ) {
				return -1;
			}
			if ( $aIndex === $bIndex ) {
				return -strnatcmp( $a, $b );
			}
			return ( $aIndex - $bIndex );
		} );

		$o = Xml::openElement( 'table',
			[ 'class' => 'wikitable mw-filepage-transcodestatus' ]
		) . "\n"
			. '<tr>'
			. '<th>' . wfMessage( 'timedmedia-transcodeinfo' )->escaped() . '</th>'
			. '<th>' . wfMessage( 'timedmedia-transcodebitrate' )->escaped() . '</th>'
			. '<th>' . wfMessage( 'timedmedia-direct-link' )->escaped() . '</th>';

		if ( $this->context->getUser()->isAllowed( 'transcode-reset' ) ) {
			$o .= '<th>' . wfMessage( 'timedmedia-actions' )->escaped() . '</th>';
		}

		$o .= '<th>' . wfMessage( 'timedmedia-status' )->escaped() . '</th>';
		$o .= '<th>' . wfMessage( 'timedmedia-transcodeduration' )->escaped() . '</th>';
		$o .= "</tr>\n";

		foreach ( $transcodeRows as $transcodeKey => $state ) {
			$o .= '<tr>';
			// Encode info:
			$o .= '<td>' . wfMessage( 'timedmedia-derivative-' . $transcodeKey )->escaped() . '</td>';
			$o .= '<td>' . $this->getTranscodeBitrate( $file, $state ) . '</td>';

			// Download file
			//
			// Note the <a download> attribute only is applied on same-origin URLs.
			// The "?download" query string append will work on servers configured
			// the way the Wikimedia production servers are, but other sites that
			// store files offsite may not have the same setup.
			//
			// On failure, these should devolve to either downloading or loading a
			// media file inline, depending on the format and browser and server
			// config.
			$downloadUrl = wfAppendQuery( self::getSourceUrl( $file, $transcodeKey ), 'download' );
			$o .= '<td>';
			$o .= ( $state['time_success'] !== null ) ?
				'<a href="' . htmlspecialchars( $downloadUrl ) . '" download title="' .
				wfMessage( 'timedmedia-download' )->escaped() . '"><div class="download-btn"><span>' .
				wfMessage( 'timedmedia-download' )->escaped() . '</span></div></a></td>' :
				wfMessage( 'timedmedia-not-ready' )->escaped();
			$o .= '</td>';

			// Check if we should include actions:
			if ( $this->context->getUser()->isAllowed( 'transcode-reset' ) ) {
				// include reset transcode action buttons
				$o .= '<td class="mw-filepage-transcodereset"><a href="#" data-transcodekey="' .
					htmlspecialchars( $transcodeKey ) . '">' . wfMessage( 'timedmedia-reset' )->escaped() .
					'</a></td>';
			}

			// Status:
			$o .= '<td>' . self::getStatusMsg( $file, $state ) . '</td>';
			$o .= '<td>' . $this->getTranscodeDuration( $file, $state ) . '</td>';

			$o .= '</tr>';
		}
		$o .= Xml::closeElement( 'table' );

		return $o;
	}

	/**
	 * @param File $file
	 * @param string $transcodeKey
	 * @return string
	 */
	public static function getSourceUrl( $file, $transcodeKey ) {
		return WebVideoTranscode::getTranscodedUrlForFile( $file, $transcodeKey );
	}

	/**
	 * @param File $file
	 * @param array $state
	 * @return string
	 */
	public function getTranscodeDuration( File $file, array $state ) {
		if ( $state['time_success'] !== null ) {
			$startTime = (int)wfTimestamp( TS_UNIX, $state['time_startwork'] );
			$endTime = (int)wfTimestamp( TS_UNIX, $state['time_success'] );
			$delta = $endTime - $startTime;
			return $this->context->getLanguage()->formatTimePeriod( $delta );
		}
		return '';
	}

	/**
	 * @param File $file
	 * @param array $state
	 * @return string
	 */
	public function getTranscodeBitrate( File $file, array $state ) {
		if ( $state['time_success'] !== null ) {
			return $this->context->getLanguage()->formatBitrate( $state['final_bitrate'] );
		}
		return '';
	}

	/**
	 * @param File $file
	 * @param array $state
	 * @return string
	 */
	public static function getStatusMsg( $file, $state ) {
		// Check for success:
		if ( $state['time_success'] !== null ) {
			return wfMessage( 'timedmedia-completed-on' )
				->dateTimeParams( $state[ 'time_success' ] )->escaped();
		}
		// Check for error:
		if ( $state['time_error'] !== null ) {
			$attribs = [];
			if ( $state['error'] !== null ) {
				$attribs = [
					'class' => 'mw-tmh-pseudo-error-link',
					'data-error' => $state['error'],
				];
			}

			return Html::rawElement( 'span', $attribs,
				wfMessage( 'timedmedia-error-on' )
					->dateTimeParams( $state['time_error'] )->escaped()
			);
		}

		// Check for started encoding
		if ( $state['time_startwork'] !== null ) {
			// Get the rough estimate of time done: ( this is not very costly considering everything else
			// that happens in an action=purge video page request )
			/*$filePath = WebVideoTranscode::getTargetEncodePath( $file, $state['key'] );
			if ( is_file( $filePath ) ) {
				$targetSize = WebVideoTranscode::getProjectedFileSize( $file, $state['key'] );
				if ( $targetSize === false ) {
					$doneMsg = wfMessage( 'timedmedia-unknown-target-size',
						$wgLang->formatSize( filesize( $filePath ) ) )->escaped();
				} else {
					$doneMsg = wfMessage('timedmedia-percent-done',
						round( filesize( $filePath ) / $targetSize, 2 ) )->escaped();
				}
			}	*/
			// Predicting percent done is not working well right now ( disabled for now )
			$doneMsg = '';
			return wfMessage(
				'timedmedia-started-transcode',
				( new MWTimestamp( $state['time_startwork'] ) )->getRelativeTimestamp(), $doneMsg
			)->escaped();
		}
		// Check for job added ( but not started encoding )
		if ( $state['time_addjob'] !== null ) {
			return wfMessage(
				'timedmedia-in-job-queue',
				( new MWTimestamp( $state['time_addjob'] ) )->getRelativeTimestamp()
			)->escaped();
		}
		// Return unknown status error:
		return wfMessage( 'timedmedia-status-unknown' )->escaped();
	}
}
