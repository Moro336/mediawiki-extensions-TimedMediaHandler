<?php
/**
 * TimedText page display the current video with subtitles to the right.
 *
 * Future features for this page"
 *  @todo add srt download links
 *  @todo parse and validate srt files
 *  @todo link-in or include the universal subtitles editor
 */
class TimedTextPage extends Article {

	// The width of the video plane:
	static private $videoWidth = 400;

	public function view() {
		global $wgOut, $wgRequest, $wgUser;

		$diff = $wgRequest->getVal( 'diff' );
		$diffOnly = $wgRequest->getBool( 'diffonly', $wgUser->getOption( 'diffonly' ) );

		if ( $this->getTitle()->getNamespace() != NS_TIMEDTEXT || ( isset( $diff ) && $diffOnly ) ) {
			parent::view();
			return;
		}
		$titleParts = explode( '.', $this->getTitle()->getDBKey() );
		array_pop( $titleParts );
		$languageKey = array_pop( $titleParts );
		$videoTitle = Title::newFromText( implode('.', $titleParts ), NS_FILE );

		// Look up the language name:
		$languages = Language::getTranslatedLanguageNames( 'en' );
		if( isset( $languages[ $languageKey ] ) ) {
			$languageName = $languages[ $languageKey ];
		} else {
			$languageName = $languageKey;
		}

		// Set title
		$wgOut->setPageTitle( wfMsg('mwe-timedtext-language-subtitles-for-clip', $languageName,  $videoTitle) );

		// Get the video with with a max of 600 pixel page
		$wgOut->addHTML(
			xml::tags( 'table', array( 'style'=> 'border:none' ),
				xml::tags( 'tr', null,
					xml::tags( 'td', array( 'valign' => 'top',  'width' => self::$videoWidth ), $this->getVideoHTML( $videoTitle ) ) .
					xml::tags( 'td', array( 'valign' => 'top' ) , $this->getSrtHTML( $languageName ) )
				)
			)
		);
	}

	/**
	 * Gets the video HTML ( with the current language set as default )
	 * @param $videoTitle string
	 * @return String
	 */
	private function getVideoHTML( $videoTitle ){
		// Get the video embed:
		$file = wfFindFile( $videoTitle );
		if( !$file ){
			return wfMsg( 'timedmedia-subtitle-no-video' );
		} else {
			$videoTransform= $file->transform(
				array(
					'width' => self::$videoWidth
				)
			);
			return $videoTransform->toHTML();
		}
	}

	/**
	 * Gets the srt text
	 *
	 * XXX We should add srt parsing and links to seek to that time in the video
	 * @param $languageName string
	 * @return Message|string
	 */
	private function getSrtHTML( $languageName ){
		if( !$this->exists() ){ // FIXME: exists() doesn't exist
			return wfMessage( 'timedmedia-subtitle-no-subtitles',  $languageName );
		}
		return '<pre style="margin-top:0px;">'. $this->getContent() . '</pre>';
	}
}
