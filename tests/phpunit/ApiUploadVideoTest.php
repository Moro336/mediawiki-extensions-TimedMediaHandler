<?php
/**
 * TestApiUploadVideo test case.
 *
 * NOTE: This build heavily on ApiUploadTest
 * ( would need to refactor ApiUploadTest for this to work better )
 *
 * @ingroup timedmedia
 * @since 0.2
 * @author Michael Dale
 */

/**
 * @group Database
 * @group Destructive
 * @group medium
 * @coversNothing Covers core ApiUpload class
 */
class ApiUploadVideoTest extends ApiTestCaseVideoUpload {

	/**
	 * @dataProvider mediaFilesProvider
	 * @param array $file
	 */
	public function testUploadVideoFiles( $file ) {
		$result = $this->uploadFile( $file );

		// Run asserts
		$this->assertTrue( isset( $result['upload'] ) );
		$this->assertEquals( 'Success', $result['upload']['result'] );
		$this->assertEquals( filesize( $file['filePath'] ),
			(int)$result['upload']['imageinfo']['size'] );
		$this->assertEquals( $file['mime'], $result['upload']['imageinfo']['mime'] );
	}

}
